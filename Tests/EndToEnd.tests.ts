import https = require("https");
import assert = require("assert");
import path = require("path")
import os = require("os")
import fs = require('fs');
import sinon = require("sinon");
import events = require("events");
import child_process = require("child_process");
import AppInsights = require("../applicationinsights");
import Sender = require("../Library/Sender");

/**
 * A fake response class that passes by default
 */
class fakeResponse {
    private callbacks: { [event: string]: (data?: any) => void } = Object.create(null);
    public setEncoding(): void { };
    public statusCode: number = 200;
    private _responseData: any;

    constructor(private passImmediately: boolean = true, responseData?: any) {
        this._responseData = responseData ? responseData : "data";
    }

    public on(event: string, callback: () => void) {
        if (!this.callbacks[event]) {
            this.callbacks[event] = callback;
        } else {
            var lastCallback = this.callbacks[event];
            this.callbacks[event] = () => {
                callback();
                lastCallback();
            };
        }

        if (event == "end" && this.passImmediately) {
            this.pass(true);
        }
    }

    public emit(eventName: string, ...args: any[]): boolean {
        return true;
    }

    public addListener(eventName: string, listener: () => void): void {
        this.on(eventName, listener);
    }

    public removeListener(eventName: string, listener: () => void) {

    }

    public pass(test = false): void {
        this.callbacks["data"] ? this.callbacks["data"](this._responseData) : null;
        this.callbacks["end"] ? this.callbacks["end"]() : null;
        this.callbacks["finish"] ? this.callbacks["finish"]() : null;
    }

    public end = this.pass;
    public once = this.on;
}

/**
 * A fake request class that fails by default
 */
class fakeRequest {
    private callbacks: { [event: string]: Function } = Object.create(null);
    public write(): void { }
    public headers: { [id: string]: string } = {};
    public agent = { protocol: 'http' };
    private _responseData: any;

    constructor(private failImmediatly: boolean = true, public url: string = undefined, responseData?: any) {
        this._responseData = responseData;
     }

    public on(event: string, callback: Function) {
        this.callbacks[event] = callback;
        if (event === "error" && this.failImmediatly) {
            setImmediate(() => this.fail());
        }
    }

    public emit(eventName: string, ...args: any[]): boolean {
        return true;
    }

    public addListener(eventName: string, listener: Function): void {
        this.on(eventName, listener);
    }

    public removeListener(eventName: string, listener?: Function) {

    }

    public fail(): void {
        this.callbacks["error"] ? this.callbacks["error"]() : null;
    }

    public end(): void {
        this.callbacks["end"] ? this.callbacks["end"](new fakeResponse(true, this._responseData)) : null;
    }
}

/**
 * A fake http server
 */
class fakeHttpServer extends events.EventEmitter {
    public setCallback(callback: any) {
        this.on("request", callback);
    }

    public listen(port: any, host?: any, backlog?: any, callback?: any) {
        this.emit("listening");
    }

    public emitRequest(url: string) {
        var request = new fakeRequest(false, url);
        var response = new fakeResponse(false);
        this.emit("request", request, response);
        request.end();
    }
}

/**
 * A fake https server class that doesn't require ssl certs
 */
class fakeHttpsServer extends events.EventEmitter {

    public setCallback(callback: any) {
        this.on("request", callback);
    }

    public listen(port: any, host?: any, backlog?: any, callback?: any) {
        this.emit("listening");
    }

    public emitRequest(url: string) {
        var request = new fakeRequest(false, url);
        var response = new fakeResponse(false);
        this.emit("request", request, response);
        request.end();
        response.pass();
    }
}

describe("EndToEnd", () => {
    let request: any;
    describe("Basic usage", () => {
        var sandbox: sinon.SinonSandbox;

        beforeEach(() => {
            sandbox = sinon.createSandbox();
            request = sandbox.stub(https, "request").callsFake((options: any, callback: any): any => {
                var req = new fakeRequest(false);
                req.on("end", callback);
                return req;
            });
        });

        afterEach(() => {
            // Dispose the default app insights client and auto collectors so that they can be reconfigured
            // cleanly for each test
            AppInsights.dispose();
            sandbox.restore();
        });

        it("should send telemetry", (done) => {
            const expectedTelemetryData: AppInsights.Contracts.AvailabilityTelemetry =  {
                duration: 100, id: "id1", message: "message1",success : true, name: "name1", runLocation: "east us"
            };

            var client = new AppInsights.TelemetryClient("iKey");

            client.trackEvent({ name: "test event" });
            client.trackException({ exception: new Error("test error") });
            client.trackMetric({ name: "test metric", value: 3 });
            client.trackTrace({ message: "test trace" });
            client.trackAvailability(expectedTelemetryData);

            client.flush({
                callback: (response) => {
                    assert.ok(response, "response should not be empty");
                    assert.ok(response !== "no data to send", "response should have data");
                    done();
                }
            });
        });
    });

    describe("Disk retry mode", () => {
        var CorrelationIdManager = require("../Library/CorrelationIdManager");
        var cidStub: sinon.SinonStub = null;
        var writeFile: sinon.SinonStub;
        var writeFileSync: sinon.SinonStub;
        var readFile: sinon.SinonStub;
        var lstat: sinon.SinonStub;
        var mkdir: sinon.SinonStub;
        var spawn: sinon.SinonStub;
        var spawnSync: sinon.SinonStub;
        let setupSpanExporterStub: sinon.SinonStub;

        beforeEach(function () {
            setupSpanExporterStub = sinon.stub(AppInsights.TelemetryClient.prototype, "setupSpanExporter");
            AppInsights.defaultClient = undefined;
            cidStub = sinon.stub(CorrelationIdManager, 'queryCorrelationId'); // TODO: Fix method of stubbing requests to allow CID to be part of E2E tests
            this.request = sinon.stub(https, 'request');
            writeFile = sinon.stub(fs, 'writeFile');
            writeFileSync = sinon.stub(fs, 'writeFileSync');
            this.exists = sinon.stub(fs, 'exists').yields(true);
            this.existsSync = sinon.stub(fs, 'existsSync').returns(true);
            this.readdir = sinon.stub(fs, 'readdir').yields(null, ['1.ai.json']);
            this.readdirSync = sinon.stub(fs, 'readdirSync').returns(['1.ai.json'] as any[]);
            this.stat = sinon.stub(fs, 'stat').yields(null, {isFile: () => true, size: 8000});
            this.statSync = sinon.stub(fs, 'statSync').returns({isFile: () => true, size: 8000} as any);
            lstat = sinon.stub(fs, 'lstat').yields(null, {isDirectory: () => true});
            mkdir = sinon.stub(fs, 'mkdir').yields(null);
            this.mkdirSync = sinon.stub(fs, 'mkdirSync').returns(null);
            readFile = sinon.stub(fs, 'readFile').yields(null, '');
            spawn = sinon.stub(child_process, 'spawn').returns({
                on: (type: string, cb: any) => {
                    if (type === 'close') {
                        cb(0);
                    }
                },
                stdout: {
                    on: (type: string, cb: any) => {
                        if (type === 'data') {
                            cb('stdoutmock');
                        }
                    }
                }
            } as any);
            if (child_process.spawnSync) {
                spawnSync = sinon.stub(child_process, 'spawnSync').returns({status: 0, stdout: 'stdoutmock'} as any);
            }
        });

        afterEach(function () {
            setupSpanExporterStub.restore();
            cidStub.restore();
            this.request.restore();
            writeFile.restore();
            this.exists.restore();
            this.readdir.restore();
            readFile.restore();
            writeFileSync.restore();
            this.existsSync.restore();
            this.stat.restore();
            lstat.restore();
            mkdir.restore();
            this.mkdirSync.restore();
            this.readdirSync.restore();
            this.statSync.restore();
            spawn.restore();
            if (child_process.spawnSync) {
                spawnSync.restore();
            }
        });

        it("disabled by default for new clients", function (done) {
            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("key");

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            setImmediate(() => {
                client.flush({
                    callback: (response: any) => {
                        // yield for the caching behavior
                        setImmediate(() => {
                            assert(writeFile.callCount === 0);
                            done();
                        });
                    }
                });
            });
        });

        it("enabled by default for default client", function (done) {
            var req = new fakeRequest();

            AppInsights.setup("key").start();
            var client = AppInsights.defaultClient;

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            setImmediate(() => {
                client.flush({
                    callback: (response: any) => {
                        // yield for the caching behavior
                        setImmediate(() => {
                            assert.equal(writeFile.callCount, 1);
                            assert.equal(spawn.callCount, os.type() === "Windows_NT" ? 2 : 0);
                            done();
                        });
                    }
                });
            })
        });

        it("stores data to disk when enabled", function (done) {
            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("key");
            client.channel.setUseDiskRetryCaching(true);

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.flush({
                callback: (response: any) => {
                    // yield for the caching behavior
                    setImmediate(() => {
                        assert(writeFile.callCount === 1);
                        assert.equal(
                            path.dirname(writeFile.firstCall.args[0]),
                            path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + "key"));
                        assert.equal(writeFile.firstCall.args[2].mode, 0o600, "File must not have weak permissions");
                        assert.equal(spawn.callCount, 0); // Should always be 0 because of caching after first call to ICACLS
                        done();
                    });
                }
            });
        });

        it("uses WindowsIdentity to get the identity for ICACLS", function (done) {
            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("uniquekey");
            client.channel.setUseDiskRetryCaching(true);
            var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
            (<any>client.channel._sender.constructor).USE_ICACLS = true; // Simulate ICACLS environment even on *nix

            // Clear ICACLS caches for test purposes
            (<any>client.channel._sender.constructor).ACL_IDENTITY = null;
            (<any>client.channel._sender.constructor).ACLED_DIRECTORIES = {};

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.flush({
                callback: (response: any) => {
                    // yield for the caching behavior
                    setImmediate(() => {
                        assert.equal(writeFile.callCount, 1);
                        assert.equal(spawn.callCount, 2);

                        // First external call should be to powershell to query WindowsIdentity
                        assert(spawn.firstCall.args[0].indexOf('powershell.exe'));
                        assert.equal(spawn.firstCall.args[1][0], "-Command");
                        assert.equal(spawn.firstCall.args[1][1], "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name");
                        assert.equal((<any>client.channel._sender.constructor).ACL_IDENTITY, 'stdoutmock');

                        // Next call should be to ICACLS (with the acquired identity)
                        assert(spawn.lastCall.args[0].indexOf('icacls.exe'));
                        assert.equal(spawn.lastCall.args[1][3], "/grant");
                        assert.equal(spawn.lastCall.args[1][4], "stdoutmock:(OI)(CI)F");

                        (<any>client.channel._sender.constructor).USE_ICACLS = origICACLS;
                        done();
                    });
                }
            });
        });

        it("refuses to store data if ACL identity fails", function (done) {
            spawn.restore();
            var tempSpawn = sinon.stub(child_process, 'spawn').returns({
                on: (type: string, cb: any) => {
                    if (type == 'close') {
                        cb(2000); // return non-zero status code
                    }
                },
                stdout: {
                    on: (type: string, cb: any) => {
                        return; // do nothing
                    }
                }
            } as any);

            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("uniquekey");
            client.channel.setUseDiskRetryCaching(true);
            var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
            (<any>client.channel._sender.constructor).USE_ICACLS = true; // Simulate ICACLS environment even on *nix

            // Set ICACLS caches for test purposes
            (<any>client.channel._sender.constructor).ACL_IDENTITY = null;
            (<any>client.channel._sender.constructor).ACLED_DIRECTORIES = {};

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.flush({
                callback: (response: any) => {
                    // yield for the caching behavior
                    setImmediate(() => {
                        assert(writeFile.callCount === 0);
                        assert.equal(tempSpawn.callCount, 1);

                        tempSpawn.restore();
                        (<any>client.channel._sender.constructor).USE_ICACLS = origICACLS;
                        done();
                    });
                }
            });
        });

        it("refuses to query for ACL identity twice", function (done) {
            spawn.restore();
            var tempSpawn = sinon.stub(child_process, 'spawn').returns({
                on: (type: string, cb: any) => {
                    if (type == 'close') {
                        cb(2000); // return non-zero status code
                    }
                },
                stdout: {
                    on: (type: string, cb: any) => {
                        return; // do nothing
                    }
                }
            } as any);

            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("uniquekey");
            client.channel.setUseDiskRetryCaching(true);
            var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
            (<any>client.channel._sender.constructor).USE_ICACLS = true; // Simulate ICACLS environment even on *nix

            // Set ICACLS caches for test purposes
            (<any>client.channel._sender.constructor).ACL_IDENTITY = null;
            (<any>client.channel._sender.constructor).ACLED_DIRECTORIES = {};

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.flush({
                callback: (response: any) => {
                    // yield for the caching behavior
                    setImmediate(() => {
                        assert(writeFile.callCount === 0);
                        assert.equal(tempSpawn.callCount, 1);

                        client.trackEvent({ name: "test event" });
                        this.request.returns(req);

                        client.flush({
                            callback: (response: any) => {
                                // yield for the caching behavior
                                setImmediate(() => {
                                    // The call counts shouldnt have changed
                                    assert(writeFile.callCount === 0);
                                    assert.equal(tempSpawn.callCount, 1);

                                    tempSpawn.restore();
                                    (<any>client.channel._sender.constructor).USE_ICACLS = origICACLS;
                                    done();
                                });
                            }
                        });
                    });
                }
            });
        });

        it("refuses to query for ACL identity twice (process never returned)", function (done) {
            spawn.restore();
            var tempSpawn = sinon.stub(child_process, 'spawn').returns({
                on: (type: string, cb: any) => {
                    return; // do nothing
                },
                stdout: {
                    on: (type: string, cb: any) => {
                        return; // do nothing
                    }
                }
            } as any);

            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("uniquekey");
            client.channel.setUseDiskRetryCaching(true);
            var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
            (<any>client.channel._sender.constructor).USE_ICACLS = true; // Simulate ICACLS environment even on *nix

            // Set ICACLS caches for test purposes
            (<any>client.channel._sender.constructor).ACL_IDENTITY = null;
            (<any>client.channel._sender.constructor).ACLED_DIRECTORIES = {};

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.flush({
                callback: (response: any) => {
                    // yield for the caching behavior
                    setImmediate(() => {
                        assert(writeFile.callCount === 0);
                        assert.equal(tempSpawn.callCount, 1);

                        client.trackEvent({ name: "test event" });
                        this.request.returns(req);

                        client.flush({
                            callback: (response: any) => {
                                // yield for the caching behavior
                                setImmediate(() => {
                                    // The call counts shouldnt have changed
                                    assert(writeFile.callCount === 0);
                                    assert.equal(tempSpawn.callCount, 1);

                                    tempSpawn.restore();
                                    (<any>client.channel._sender.constructor).USE_ICACLS = origICACLS;
                                    done();
                                });
                            }
                        });
                    });
                }
            });
        });

        it("refuses to store data if ICACLS fails", function (done) {
            spawn.restore();
            var tempSpawn = sinon.stub(child_process, 'spawn').returns({
                on: (type: string, cb: any) => {
                    if (type == 'close') {
                        cb(2000); // return non-zero status code
                    }
                }
            } as any);

            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("uniquekey");
            client.channel.setUseDiskRetryCaching(true);
            var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
            (<any>client.channel._sender.constructor).USE_ICACLS = true; // Simulate ICACLS environment even on *nix

            // Set ICACLS caches for test purposes
            (<any>client.channel._sender.constructor).ACL_IDENTITY = 'testidentity'; // Don't use spawn for identity
            (<any>client.channel._sender.constructor).ACLED_DIRECTORIES = {};

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.flush({
                callback: (response: any) => {
                    // yield for the caching behavior
                    setImmediate(() => {
                        assert(writeFile.callCount === 0);
                        assert.equal(tempSpawn.callCount, 1);

                        tempSpawn.restore();
                        (<any>client.channel._sender.constructor).USE_ICACLS = origICACLS;
                        done();
                    });
                }
            });
        });

        it("creates directory when nonexistent", function (done) {
            lstat.restore();
            var tempLstat = sinon.stub(fs, 'lstat').yields({code: "ENOENT"}, null);

            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("key");
            client.channel.setUseDiskRetryCaching(true);

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.flush({
                callback: (response: any) => {
                    setImmediate(() => {
                        assert.equal(mkdir.callCount, 1);
                        assert.equal(mkdir.firstCall.args[0], path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + "key"));
                        assert.equal(writeFile.callCount, 1);
                        assert.equal(
                            path.dirname(writeFile.firstCall.args[0]),
                            path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + "key"));
                        assert.equal(writeFile.firstCall.args[2].mode, 0o600, "File must not have weak permissions");

                        tempLstat.restore();
                        done();
                    });
                }
            });
        });

        it("does not store data when limit is below directory size", function (done) {
            var req = new fakeRequest();

            var client = new AppInsights.TelemetryClient("key");
            client.channel.setUseDiskRetryCaching(true, null, 10); // 10 bytes is less than synthetic directory size (see file size in stat mock)

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.flush({
                callback: (response: any) => {
                    // yield for the caching behavior
                    setImmediate(() => {
                        assert(writeFile.callCount === 0);
                        done();
                    });
                }
            });
        });

        it("checks for files when connection is back online", function (done) {
            var req = new fakeRequest(false);
            var res = new fakeResponse();
            res.statusCode = 200;

            var client = new AppInsights.TelemetryClient("key");
            client.channel.setUseDiskRetryCaching(true, 0);

            client.trackEvent({ name: "test event" });

            this.request.returns(req);
            this.request.yields(res);

            client.flush({
                callback: (response: any) => {
                    // wait until sdk looks for offline files
                    setTimeout(() => {
                        assert(this.readdir.callCount === 1);
                        assert(readFile.callCount === 1);
                        assert.equal(
                            path.dirname(readFile.firstCall.args[0]),
                            path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + "key"));
                        done();
                    }, 10);
                }
            });
        });

        it("cache payload synchronously when process crashes (Node >= 0.11.12)", function () {
            var nodeVer = process.versions.node.split(".");
            if (parseInt(nodeVer[0]) > 0 || parseInt(nodeVer[1]) > 11 || (parseInt(nodeVer[1]) == 11) && parseInt(nodeVer[2]) > 11) {
                var req = new fakeRequest(true);

                var client = new AppInsights.TelemetryClient("key2");
                client.channel.setUseDiskRetryCaching(true);

                client.trackEvent({ name: "test event" });

                this.request.returns(req);

                client.channel.triggerSend(true);

                assert(this.existsSync.callCount === 1);
                assert(writeFileSync.callCount === 1);
                assert.equal(spawnSync.callCount, os.type() === "Windows_NT" ? 1 : 0); // This is implicitly testing caching of ACL identity (otherwise call count would be 2 like it is the non-sync time)
                assert.equal(
                    path.dirname(writeFileSync.firstCall.args[0]),
                    path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + "key2"));
                assert.equal(writeFileSync.firstCall.args[2].mode, 0o600, "File must not have weak permissions");
            }
        });

        it("cache payload synchronously when process crashes (Node < 0.11.12, ICACLS)", function () {
            var nodeVer = process.versions.node.split(".");
            if (!(parseInt(nodeVer[0]) > 0 || parseInt(nodeVer[1]) > 11 || (parseInt(nodeVer[1]) == 11) && parseInt(nodeVer[2]) > 11)) {
                var req = new fakeRequest(true);

                var client = new AppInsights.TelemetryClient("key22");
                client.channel.setUseDiskRetryCaching(true);
                var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
                (<any>client.channel._sender.constructor).USE_ICACLS = true; // Simulate ICACLS environment even on *nix

                client.trackEvent({ name: "test event" });

                this.request.returns(req);

                client.channel.triggerSend(true);

                assert(this.existsSync.callCount === 1);
                assert(writeFileSync.callCount === 0);
                (<any>client.channel._sender.constructor).USE_ICACLS = origICACLS;
            }
        });

        it("cache payload synchronously when process crashes (Node < 0.11.12, Non-ICACLS)", function () {
            var nodeVer = process.versions.node.split(".");
            if (!(parseInt(nodeVer[0]) > 0 || parseInt(nodeVer[1]) > 11 || (parseInt(nodeVer[1]) == 11) && parseInt(nodeVer[2]) > 11)) {
                var req = new fakeRequest(true);

                var client = new AppInsights.TelemetryClient("key23");
                client.channel.setUseDiskRetryCaching(true);
                var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
                (<any>client.channel._sender.constructor).USE_ICACLS = false; // Simulate Non-ICACLS environment even on Windows

                client.trackEvent({ name: "test event" });

                this.request.returns(req);

                client.channel.triggerSend(true);

                assert(this.existsSync.callCount === 1);
                assert(writeFileSync.callCount === 1);
                assert.equal(
                    path.dirname(writeFileSync.firstCall.args[0]),
                    path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + "key23"));
                assert.equal(writeFileSync.firstCall.args[2].mode, 0o600, "File must not have weak permissions");
            }
        });

        it("use WindowsIdentity to get ACL identity when process crashes (Node > 0.11.12, ICACLS)", function () {
            var nodeVer = process.versions.node.split(".");
            if ((parseInt(nodeVer[0]) > 0 || parseInt(nodeVer[1]) > 11 || (parseInt(nodeVer[1]) == 11) && parseInt(nodeVer[2]) > 11)) {
                var req = new fakeRequest(true);

                var client = new AppInsights.TelemetryClient("key22");
                client.channel.setUseDiskRetryCaching(true);
                var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
                (<any>client.channel._sender.constructor).USE_ICACLS = true; // Simulate ICACLS environment even on *nix

                // Set ICACLS caches for test purposes
                (<any>client.channel._sender.constructor).ACL_IDENTITY = null;
                (<any>client.channel._sender.constructor).ACLED_DIRECTORIES = {};

                client.trackEvent({ name: "test event" });

                this.request.returns(req);

                client.channel.triggerSend(true);

                // First external call should be to powershell to query WindowsIdentity
                assert(spawnSync.firstCall.args[0].indexOf('powershell.exe'));
                assert.equal(spawnSync.firstCall.args[1][0], "-Command");
                assert.equal(spawnSync.firstCall.args[1][1], "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name");
                assert.equal((<any>client.channel._sender.constructor).ACL_IDENTITY, 'stdoutmock');

                // Next call should be to ICACLS (with the acquired identity)
                assert(spawnSync.lastCall.args[0].indexOf('icacls.exe'));
                assert.equal(spawnSync.lastCall.args[1][3], "/grant");
                assert.equal(spawnSync.lastCall.args[1][4], "stdoutmock:(OI)(CI)F");

                (<any>client.channel._sender.constructor).USE_ICACLS = origICACLS;
            }
        });

        it("refuses to cache payload when process crashes if ICACLS fails", function () {
            if (child_process.spawnSync) { // Doesn't exist in Node < 0.11.12
                spawnSync.restore();
                var tempSpawnSync = sinon.stub(child_process, 'spawnSync').returns({status: 2000} as any);
            }

            var req = new fakeRequest(true);

            var client = new AppInsights.TelemetryClient("key3"); // avoid icacls cache by making key unique
            client.channel.setUseDiskRetryCaching(true);
            var origICACLS = (<any>client.channel._sender.constructor).USE_ICACLS;
            (<any>client.channel._sender.constructor).USE_ICACLS = true; // Simulate ICACLS environment even on *nix

            client.trackEvent({ name: "test event" });

            this.request.returns(req);

            client.channel.triggerSend(true);

            assert(this.existsSync.callCount === 1);
            assert(writeFileSync.callCount === 0);

            if (child_process.spawnSync) {
                assert.equal(tempSpawnSync.callCount, 1);

                (<any>client.channel._sender.constructor).USE_ICACLS = origICACLS;
                tempSpawnSync.restore();
            }
        });
    });
});
