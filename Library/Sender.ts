﻿import fs = require("fs");
import os = require("os");
import path = require("path");
import zlib = require("zlib");
import child_process = require("child_process");

import coreHttp = require("@azure/core-http");

import Logging = require("./Logging");
import Config = require("./Config")
import {
    ApplicationInsightsClient,
    ApplicationInsightsClientOptionalParams,
    ApplicationInsightsClientTrackResponse,
    TelemetryItem
} from "../generated";


class Sender {
    private readonly _appInsightsClient: ApplicationInsightsClient;
    private _appInsightsClientOptions: ApplicationInsightsClientOptionalParams;
    private _appInsightsClientFactories: coreHttp.RequestPolicyFactory[];
    private static TAG = "Sender";
    private static ICACLS_PATH = `${process.env.systemdrive}/windows/system32/icacls.exe`;
    private static POWERSHELL_PATH = `${process.env.systemdrive}/windows/system32/windowspowershell/v1.0/powershell.exe`;
    private static ACLED_DIRECTORIES: { [id: string]: boolean } = {};
    private static ACL_IDENTITY: string = null;

    // the amount of time the SDK will wait between resending cached data, this buffer is to avoid any throttling from the service side
    public static WAIT_BETWEEN_RESEND = 60 * 1000;
    public static MAX_BYTES_ON_DISK = 50 * 1000 * 1000;
    public static MAX_CONNECTION_FAILURES_BEFORE_WARN = 5;
    public static TEMPDIR_PREFIX: string = "appInsights-node";
    public static OS_PROVIDES_FILE_PROTECTION = false;
    public static USE_ICACLS = os.type() === "Windows_NT";

    private _config: Config;
    private _onSuccess: (response: string) => void;
    private _onError: (error: Error) => void;
    private _enableDiskRetryMode: boolean;
    private _numConsecutiveFailures: number;
    private _resendTimer: NodeJS.Timer | null;
    protected _resendInterval: number;
    protected _maxBytesOnDisk: number;

    constructor(config: Config, onSuccess?: (response: string) => void, onError?: (error: Error) => void) {
        this._config = config;
        this._onSuccess = onSuccess;
        this._onError = onError;
        this._enableDiskRetryMode = false;
        this._resendInterval = Sender.WAIT_BETWEEN_RESEND;
        this._maxBytesOnDisk = Sender.MAX_BYTES_ON_DISK;
        this._numConsecutiveFailures = 0;
        this._resendTimer = null;

        this._appInsightsClientFactories = [
            coreHttp.keepAlivePolicy({
                enable: false
            }),
            coreHttp.deserializationPolicy(), //default
        ];

        this._appInsightsClientOptions = {
            host: this._config.endpointUrl,
            // requestPolicyFactories: this._appInsightsClientFactories
        };

        this._appInsightsClient = new ApplicationInsightsClient({
            ...this._appInsightsClientOptions
        });

        if (!Sender.OS_PROVIDES_FILE_PROTECTION) {
            // Node's chmod levels do not appropriately restrict file access on Windows
            // Use the built-in command line tool ICACLS on Windows to properly restrict
            // access to the temporary directory used for disk retry mode.
            if (Sender.USE_ICACLS) {
                // This should be async - but it's currently safer to have this synchronous
                // This guarantees we can immediately fail setDiskRetryMode if we need to
                try {
                    Sender.OS_PROVIDES_FILE_PROTECTION = fs.existsSync(Sender.ICACLS_PATH);
                } catch (e) { }
                if (!Sender.OS_PROVIDES_FILE_PROTECTION) {
                    Logging.warn(Sender.TAG, "Could not find ICACLS in expected location! This is necessary to use disk retry mode on Windows.")
                }
            } else {
                // chmod works everywhere else
                Sender.OS_PROVIDES_FILE_PROTECTION = true;
            }
        }
    }

    /**
    * Enable or disable offline mode
    */
    public setDiskRetryMode(value: boolean, resendInterval?: number, maxBytesOnDisk?: number) {
        this._enableDiskRetryMode = Sender.OS_PROVIDES_FILE_PROTECTION && value;
        if (typeof resendInterval === 'number' && resendInterval >= 0) {
            this._resendInterval = Math.floor(resendInterval);
        }
        if (typeof maxBytesOnDisk === 'number' && maxBytesOnDisk >= 0) {
            this._maxBytesOnDisk = Math.floor(maxBytesOnDisk);
        }

        if (value && !Sender.OS_PROVIDES_FILE_PROTECTION) {
            this._enableDiskRetryMode = false;
            Logging.warn(Sender.TAG, "Ignoring request to enable disk retry mode. Sufficient file protection capabilities were not detected.")
        }
    }

    public async send(envelopes: TelemetryItem[], callback?: (v: string) => void) {

        try {
            var responseString = "";
            const response: ApplicationInsightsClientTrackResponse = await this._appInsightsClient.track(envelopes);

            responseString = response._response.bodyAsText;
            Logging.info(Sender.TAG, responseString);

            if (typeof callback === "function") {
                callback(responseString);
            }

            if (this._enableDiskRetryMode) {
                // try to send any cached events if the user is back online
                let statusCode = response._response.status;
                if (statusCode === 200) {
                    if (!this._resendTimer) {
                        this._resendTimer = setTimeout(() => {
                            this._resendTimer = null;
                            this._sendFirstFileOnDisk()
                        }, this._resendInterval);
                        this._resendTimer.unref();
                    }
                    // store to disk in case of burst throttling
                } else if (
                    statusCode === 408 || // Timeout
                    statusCode === 429 || // Throttle
                    statusCode === 439 || // Quota
                    statusCode === 500 || // Server Error
                    statusCode === 503) { // Service unavailable

                    const filteredEnvelopes: TelemetryItem[] = response.errors.reduce(
                        (acc, v) => [...acc, envelopes[v.index]],
                        [] as TelemetryItem[]
                    );

                    // TODO: Do not support partial success (206) until _sendFirstFileOnDisk checks payload age
                    this._storeToDisk(filteredEnvelopes);
                }
            }
            this._numConsecutiveFailures = 0;
        }
        catch (senderErr) {
            if (this._isNetworkError(senderErr)) {
                this._numConsecutiveFailures++;

                // Only use warn level if retries are disabled or we've had some number of consecutive failures sending data
                // This is because warn level is printed in the console by default, and we don't want to be noisy for transient and self-recovering errors
                // Continue informing on each failure if verbose logging is being used
                if (!this._enableDiskRetryMode || this._numConsecutiveFailures > 0 && this._numConsecutiveFailures % Sender.MAX_CONNECTION_FAILURES_BEFORE_WARN === 0) {
                    let notice = "Ingestion endpoint could not be reached. This batch of telemetry items has been lost. Use Disk Retry Caching to enable resending of failed telemetry. Error:";
                    if (this._enableDiskRetryMode) {
                        notice = `Ingestion endpoint could not be reached ${this._numConsecutiveFailures} consecutive times. There may be resulting telemetry loss. Most recent error:`;
                    }
                    Logging.warn(Sender.TAG, notice, senderErr);
                } else {
                    let notice = "Transient failure to reach ingestion endpoint. This batch of telemetry items will be retried. Error:";
                    Logging.info(Sender.TAG, notice, senderErr)
                }
                this._onErrorHelper(senderErr);

                if (this._enableDiskRetryMode) {
                    this._storeToDisk(envelopes);
                }
            }

            if (typeof callback === "function") {
                var errorMessage = "error sending telemetry";
                if (senderErr && (typeof senderErr.toString === "function")) {
                    errorMessage = senderErr.toString();
                }
                callback(errorMessage);
            }
        }

    }

    public saveOnCrash(envelopes: TelemetryItem[]) {
        if (this._enableDiskRetryMode) {
            this._storeToDiskSync(envelopes);
        }
    }

    private _isNetworkError(error: Error): boolean {
        if (error instanceof coreHttp.RestError) {
            if (error && error.code && error.code === "REQUEST_SEND_ERROR") {
                return true;
            }
        }
        return false;
    }

    private _runICACLS(args: string[], callback: (err: Error) => void) {
        var aclProc = child_process.spawn(Sender.ICACLS_PATH, args, <any>{ windowsHide: true });
        aclProc.on("error", (e: Error) => callback(e));
        aclProc.on("close", (code: number, signal: string) => {
            return callback(code === 0 ? null : new Error(`Setting ACL restrictions did not succeed (ICACLS returned code ${code})`));
        });
    }

    private _runICACLSSync(args: string[]) {
        // Some very old versions of Node (< 0.11) don't have this
        if (child_process.spawnSync) {
            var aclProc = child_process.spawnSync(Sender.ICACLS_PATH, args, <any>{ windowsHide: true });
            if (aclProc.error) {
                throw aclProc.error;
            } else if (aclProc.status !== 0) {
                throw new Error(`Setting ACL restrictions did not succeed (ICACLS returned code ${aclProc.status})`);
            }
        } else {
            throw new Error("Could not synchronously call ICACLS under current version of Node.js");
        }
    }

    private _getACLIdentity(callback: (error: Error, identity: string) => void) {
        if (Sender.ACL_IDENTITY) {
            return callback(null, Sender.ACL_IDENTITY);
        }
        var psProc = child_process.spawn(Sender.POWERSHELL_PATH,
            ["-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name"], <any>{
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'] // Needed to prevent hanging on Win 7
            });
        let data = "";
        psProc.stdout.on("data", (d: string) => data += d);
        psProc.on("error", (e: Error) => callback(e, null));
        psProc.on("close", (code: number, signal: string) => {
            Sender.ACL_IDENTITY = data && data.trim();
            return callback(
                code === 0 ? null : new Error(`Getting ACL identity did not succeed (PS returned code ${code})`),
                Sender.ACL_IDENTITY);
        });
    }

    private _getACLIdentitySync() {
        if (Sender.ACL_IDENTITY) {
            return Sender.ACL_IDENTITY;
        }
        // Some very old versions of Node (< 0.11) don't have this
        if (child_process.spawnSync) {
            var psProc = child_process.spawnSync(Sender.POWERSHELL_PATH,
                ["-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name"], <any>{
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'] // Needed to prevent hanging on Win 7
                });
            if (psProc.error) {
                throw psProc.error;
            } else if (psProc.status !== 0) {
                throw new Error(`Getting ACL identity did not succeed (PS returned code ${psProc.status})`);
            }
            Sender.ACL_IDENTITY = psProc.stdout && psProc.stdout.toString().trim();
            return Sender.ACL_IDENTITY;
        } else {
            throw new Error("Could not synchronously get ACL identity under current version of Node.js");
        }
    }

    private _getACLArguments(directory: string, identity: string) {
        return [directory,
            "/grant", "*S-1-5-32-544:(OI)(CI)F", // Full permission for Administrators
            "/grant", `${identity}:(OI)(CI)F`, // Full permission for current user
            "/inheritance:r"]; // Remove all inherited permissions
    }

    private _applyACLRules(directory: string, callback: (err: Error) => void) {
        if (!Sender.USE_ICACLS) {
            return callback(null);
        }

        // For performance, only run ACL rules if we haven't already during this session
        if (Sender.ACLED_DIRECTORIES[directory] === undefined) {
            // Avoid multiple calls race condition by setting ACLED_DIRECTORIES to false for this directory immediately
            // If batches are being failed faster than the processes spawned below return, some data won't be stored to disk
            // This is better than the alternative of potentially infinitely spawned processes
            Sender.ACLED_DIRECTORIES[directory] = false;

            // Restrict this directory to only current user and administrator access
            this._getACLIdentity((err, identity) => {
                if (err) {
                    Sender.ACLED_DIRECTORIES[directory] = false; // false is used to cache failed (vs undefined which is "not yet tried")
                    return callback(err);
                } else {
                    this._runICACLS(this._getACLArguments(directory, identity), (err) => {
                        Sender.ACLED_DIRECTORIES[directory] = !err;
                        return callback(err);
                    });
                }
            });
        } else {
            return callback(Sender.ACLED_DIRECTORIES[directory] ? null :
                new Error("Setting ACL restrictions did not succeed (cached result)"));
        }
    }

    private _applyACLRulesSync(directory: string) {
        if (Sender.USE_ICACLS) {
            // For performance, only run ACL rules if we haven't already during this session
            if (Sender.ACLED_DIRECTORIES[directory] === undefined) {
                this._runICACLSSync(this._getACLArguments(directory, this._getACLIdentitySync()));
                Sender.ACLED_DIRECTORIES[directory] = true; // If we get here, it succeeded. _runIACLSSync will throw on failures
                return;
            } else if (!Sender.ACLED_DIRECTORIES[directory]) { // falsy but not undefined
                throw new Error("Setting ACL restrictions did not succeed (cached result)");
            }
        }
    }

    private _confirmDirExists(directory: string, callback: (err: NodeJS.ErrnoException) => void): void {
        fs.lstat(directory, (err, stats) => {
            if (err && err.code === 'ENOENT') {
                fs.mkdir(directory, (err) => {
                    if (err && err.code !== 'EEXIST') { // Handle race condition by ignoring EEXIST
                        callback(err);
                    } else {
                        this._applyACLRules(directory, callback);
                    }
                });
            } else if (!err && stats.isDirectory()) {
                this._applyACLRules(directory, callback);
            } else {
                callback(err || new Error("Path existed but was not a directory"));
            }
        });
    }

    /**
     * Computes the size (in bytes) of all files in a directory at the root level. Asynchronously.
     */
    private _getShallowDirectorySize(directory: string, callback: (err: NodeJS.ErrnoException, size: number) => void) {
        // Get the directory listing
        fs.readdir(directory, (err, files) => {
            if (err) {
                return callback(err, -1);
            }

            let error: NodeJS.ErrnoException = null;
            let totalSize = 0;
            let count = 0;

            if (files.length === 0) {
                callback(null, 0);
                return;
            }

            // Query all file sizes
            for (let i = 0; i < files.length; i++) {
                fs.stat(path.join(directory, files[i]), (err, fileStats) => {
                    count++;

                    if (err) {
                        error = err;
                    } else {
                        if (fileStats.isFile()) {
                            totalSize += fileStats.size;
                        }
                    }

                    if (count === files.length) {
                        // Did we get an error?
                        if (error) {
                            callback(error, -1);
                        } else {
                            callback(error, totalSize);
                        }
                    }
                });
            }
        });
    }

    /**
     * Computes the size (in bytes) of all files in a directory at the root level. Synchronously.
     */
    private _getShallowDirectorySizeSync(directory: string): number {
        let files = fs.readdirSync(directory);
        let totalSize = 0;
        for (let i = 0; i < files.length; i++) {
            totalSize += fs.statSync(path.join(directory, files[i])).size;
        }
        return totalSize;
    }

    /**
     * Stores the payload as a json file on disk in the temp directory
     */
    private _storeToDisk(envelopes: TelemetryItem[]) {
        // tmpdir is /tmp for *nix and USERDIR/AppData/Local/Temp for Windows
        var directory = path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + this._config.instrumentationKey);

        // This will create the dir if it does not exist
        // Default permissions on *nix are directory listing from other users but no file creations
        Logging.info(Sender.TAG, "Checking existence of data storage directory: " + directory);
        this._confirmDirExists(directory, (error) => {
            if (error) {
                Logging.warn(Sender.TAG, "Error while checking/creating directory: " + (error && error.message));
                this._onErrorHelper(error);
                return;
            }

            this._getShallowDirectorySize(directory, (err, size) => {
                if (err || size < 0) {
                    Logging.warn(Sender.TAG, "Error while checking directory size: " + (err && err.message));
                    this._onErrorHelper(err);
                    return;
                } else if (size > this._maxBytesOnDisk) {
                    Logging.warn(Sender.TAG, "Not saving data due to max size limit being met. Directory size in bytes is: " + size);
                    return;
                }

                //create file - file name for now is the timestamp, a better approach would be a UUID but that
                //would require an external dependency
                var fileName = new Date().getTime() + ".ai.json";
                var fileFullPath = path.join(directory, fileName);

                // Mode 600 is w/r for creator and no read access for others (only applies on *nix)
                // For Windows, ACL rules are applied to the entire directory (see logic in _confirmDirExists and _applyACLRules)
                Logging.info(Sender.TAG, "saving data to disk at: " + fileFullPath);
                fs.writeFile(fileFullPath, JSON.stringify(envelopes), { mode: 0o600 }, (error) => this._onErrorHelper(error));
            });
        });
    }

    /**
     * Stores the payload as a json file on disk using sync file operations
     * this is used when storing data before crashes
     */
    private _storeToDiskSync(payload: any) {
        // tmpdir is /tmp for *nix and USERDIR/AppData/Local/Temp for Windows
        var directory = path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + this._config.instrumentationKey);

        try {
            Logging.info(Sender.TAG, "Checking existence of data storage directory: " + directory);
            if (!fs.existsSync(directory)) {
                fs.mkdirSync(directory);
            }

            // Make sure permissions are valid
            this._applyACLRulesSync(directory);

            let dirSize = this._getShallowDirectorySizeSync(directory);
            if (dirSize > this._maxBytesOnDisk) {
                Logging.info(Sender.TAG, "Not saving data due to max size limit being met. Directory size in bytes is: " + dirSize);
                return;
            }

            //create file - file name for now is the timestamp, a better approach would be a UUID but that
            //would require an external dependency
            var fileName = new Date().getTime() + ".ai.json";
            var fileFullPath = path.join(directory, fileName);

            // Mode 600 is w/r for creator and no access for anyone else (only applies on *nix)
            Logging.info(Sender.TAG, "saving data before crash to disk at: " + fileFullPath);
            fs.writeFileSync(fileFullPath, payload, { mode: 0o600 });

        } catch (error) {
            Logging.warn(Sender.TAG, "Error while saving data to disk: " + (error && error.message));
            this._onErrorHelper(error);
        }
    }

    /**
     * Check for temp telemetry files
     * reads the first file if exist, deletes it and tries to send its load
     */
    private _sendFirstFileOnDisk(): void {
        var tempDir = path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + this._config.instrumentationKey);

        fs.exists(tempDir, (exists: boolean) => {
            if (exists) {
                fs.readdir(tempDir, (error, files) => {
                    if (!error) {
                        files = files.filter(f => path.basename(f).indexOf(".ai.json") > -1);
                        if (files.length > 0) {
                            var firstFile = files[0];
                            var filePath = path.join(tempDir, firstFile);
                            fs.readFile(filePath, (error, buffer) => {
                                if (!error) {
                                    // delete the file first to prevent double sending
                                    fs.unlink(filePath, (error) => {
                                        if (!error) {
                                            let payload = JSON.parse(buffer.toString("utf8"));
                                            this.send(payload);
                                        } else {
                                            this._onErrorHelper(error);
                                        }
                                    });
                                } else {
                                    this._onErrorHelper(error);
                                }
                            });
                        }
                    } else {
                        this._onErrorHelper(error);
                    }
                });
            }
        });
    }

    private _onErrorHelper(error: Error): void {
        if (typeof this._onError === "function") {
            this._onError(error);
        }
    }
}

export = Sender;
