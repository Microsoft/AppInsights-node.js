import http = require("http");
import https = require("https");
import url = require("url");

import TelemetryClient = require("../Library/TelemetryClient");
import Logging = require("../Library/Logging");
import Util = require("../Library/Util");
import RequestResponseHeaders = require("../Library/RequestResponseHeaders");
import HttpDependencyParser = require("./HttpDependencyParser");
import { CorrelationContextManager, CorrelationContext, PrivateCustomProperties } from "./CorrelationContextManager";

import {enable as enableMongodb} from "./diagnostic-channel/mongodb.sub";
import {enable as enableMysql} from "./diagnostic-channel/mysql.sub";
import {enable as enableRedis} from "./diagnostic-channel/redis.sub";
import {enable as enablePostgres} from "./diagnostic-channel/postgres.sub";

import "./diagnostic-channel/initialization";

class AutoCollectHttpDependencies {
    public static disableCollectionRequestOption = 'disableAppInsightsAutoCollection';

    public static INSTANCE: AutoCollectHttpDependencies;

    private static requestNumber = 1;

    // The difference between this and the disable flag above is that we delete this flag before returning to user code.
    // The idea is we create this flag inside patched code, and delete it before returning from it, so the user has no impact from it
    // We use this flag to ensure we don't double-collect telemetry
    private static alreadyAutoCollectedFlag = '_appInsightsAutoCollected';

    private _client: TelemetryClient;
    private _isEnabled: boolean;
    private _isInitialized: boolean;

    constructor(client: TelemetryClient) {
        if (!!AutoCollectHttpDependencies.INSTANCE) {
            throw new Error("Client request tracking should be configured from the applicationInsights object");
        }

        AutoCollectHttpDependencies.INSTANCE = this;
        this._client = client;
    }

    public enable(isEnabled: boolean) {
        this._isEnabled = isEnabled;
        if (this._isEnabled && !this._isInitialized) {
            this._initialize();
        }
        enableMongodb(isEnabled, this._client);
        enableMysql(isEnabled, this._client);
        enableRedis(isEnabled, this._client);
        enablePostgres(isEnabled, this._client);
    }

    public isInitialized() {
        return this._isInitialized;
    }

    private _initialize() {
        this._isInitialized = true;

        const originalRequest = http.request;
        const originalHttpsRequest = https.request;

        // On node >= v0.11.12 and < 9.0 (excluding 8.9.0) https.request just calls http.request (with additional options).
        // On node < 0.11.12, 8.9.0, and 9.0 > https.request is handled separately
        // Patch both and leave a flag to not double-count on versions that just call through
        // We add the flag to both http and https to protect against strange double collection in other scenarios
        http.request = (options, ...requestArgs: any[]) => {
            var shouldCollect = !(<any>options)[AutoCollectHttpDependencies.disableCollectionRequestOption] &&
                !(<any>options)[AutoCollectHttpDependencies.alreadyAutoCollectedFlag];

            (<any>options)[AutoCollectHttpDependencies.alreadyAutoCollectedFlag] = true;

            const request: http.ClientRequest = originalRequest.call(
                http, options, ...requestArgs);
            if (request && options && shouldCollect) {
                AutoCollectHttpDependencies.trackRequest(this._client, options, request);
            }

            delete (<any>options)[AutoCollectHttpDependencies.alreadyAutoCollectedFlag];

            return request;
        };

        https.request = (options, ...requestArgs: any[]) => {
            var shouldCollect = !(<any>options)[AutoCollectHttpDependencies.disableCollectionRequestOption] &&
                !(<any>options)[AutoCollectHttpDependencies.alreadyAutoCollectedFlag];

            (<any>options)[AutoCollectHttpDependencies.alreadyAutoCollectedFlag] = true;

            const request: http.ClientRequest = originalHttpsRequest.call(
                https, options, ...requestArgs);
            if (request && options && shouldCollect) {
                AutoCollectHttpDependencies.trackRequest(this._client, options, request);
            }

            delete (<any>options)[AutoCollectHttpDependencies.alreadyAutoCollectedFlag];

            return request;
        };
    }

    /**
     * Tracks an outgoing request. Because it may set headers this method must be called before
     * writing content to or ending the request.
     */
    public static trackRequest(client: TelemetryClient, requestOptions: string | http.RequestOptions | https.RequestOptions, request: http.ClientRequest,
        properties?: { [key: string]: string }) {
        if (!requestOptions || !request || !client) {
            Logging.info("AutoCollectHttpDependencies.trackRequest was called with invalid parameters: ", !requestOptions, !request, !client);
            return;
        }

        let requestParser = new HttpDependencyParser(requestOptions, request);

        const currentContext = CorrelationContextManager.getCurrentContext();
        const uniqueRequestId = currentContext && currentContext.operation && (currentContext.operation.parentId + AutoCollectHttpDependencies.requestNumber++ + '.');

        // Add the source correlationId to the request headers, if a value was not already provided.
        // The getHeader/setHeader methods aren't available on very old Node versions, and
        // are not included in the v0.10 type declarations currently used. So check if the
        // methods exist before invoking them.
        if (Util.canIncludeCorrelationHeader(client, requestParser.getUrl()) &&
            request['getHeader'] && request['setHeader']) {
            if (client.config && client.config.correlationId) {
                const correlationHeader = request['getHeader'](RequestResponseHeaders.requestContextHeader);
                if (correlationHeader) {
                    const components = correlationHeader.split(",");
                    const key = `${RequestResponseHeaders.requestContextSourceKey}=`;
                    const roleNameKey = `${RequestResponseHeaders.requestContextSourceRoleNameKey}=`;
                    if (!components.some((value) => value.substring(0,key.length) === key)) {
                        request['setHeader'](
                            RequestResponseHeaders.requestContextHeader, 
                            `${correlationHeader},${RequestResponseHeaders.requestContextSourceKey}=${client.config.correlationId},${RequestResponseHeaders.requestContextSourceRoleNameKey}=${client.context.tags[client.context.keys.cloudRole]}`);
                    }
                } else {
                    request['setHeader'](
                        RequestResponseHeaders.requestContextHeader, 
                        `${RequestResponseHeaders.requestContextSourceKey}=${client.config.correlationId},${RequestResponseHeaders.requestContextSourceRoleNameKey}=${client.context.tags[client.context.keys.cloudRole]}`);
                }
            }

            if (currentContext && currentContext.operation) {
                request['setHeader'](RequestResponseHeaders.requestIdHeader, uniqueRequestId);
                // Also set legacy headers
                request['setHeader'](RequestResponseHeaders.parentIdHeader, currentContext.operation.id);
                request['setHeader'](RequestResponseHeaders.rootIdHeader, uniqueRequestId);

                const correlationContextHeader = (<PrivateCustomProperties>currentContext.customProperties).serializeToHeader();
                if (correlationContextHeader) {
                    request['setHeader'](RequestResponseHeaders.correlationContextHeader, correlationContextHeader);
                }
            }
        }

        // Collect dependency telemetry about the request when it finishes.
        if (request.on) {
            request.on('response', (response: http.ClientResponse) => {
                requestParser.onResponse(response, properties);
                var context : { [name: string]: any; } = { "http.RequestOptions": requestOptions, "http.ClientRequest": request, "http.ClientResponse": response };
                var dependencyTelemetry = requestParser.getDependencyTelemetry(uniqueRequestId);
                dependencyTelemetry.contextObjects = context;
                client.trackDependency(dependencyTelemetry);
            });
            request.on('error', (e: Error) => {
                requestParser.onError(e, properties);
                var context : { [name: string]: any; } = { "http.RequestOptions": requestOptions, "http.ClientRequest": request, "Error": e };
                var dependencyTelemetry = requestParser.getDependencyTelemetry(uniqueRequestId);
                dependencyTelemetry.contextObjects = context;
                client.trackDependency(dependencyTelemetry);
            });
        }
    }

    public dispose() {
        AutoCollectHttpDependencies.INSTANCE = null;
        this.enable(false);
        this._isInitialized = false;
    }
}

export = AutoCollectHttpDependencies;
