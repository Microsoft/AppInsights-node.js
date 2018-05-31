import http = require("http");
import https = require("https");
import url = require("url");

import Contracts = require("../Declarations/Contracts");
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

        const originalGet = http.get;
        const originalRequest = http.request;
        const originalHttpsRequest = https.request;

        const clientRequestPatch = (request: http.ClientRequest, options: http.RequestOptions | https.RequestOptions) => {
            var shouldCollect = !(<any>options)[AutoCollectHttpDependencies.disableCollectionRequestOption] &&
                !(<any>request)[AutoCollectHttpDependencies.alreadyAutoCollectedFlag];

            (<any>request)[AutoCollectHttpDependencies.alreadyAutoCollectedFlag] = true;

            if (request && options && shouldCollect) {
                AutoCollectHttpDependencies.trackRequest(this._client, {options: options, request: request});
            }
        };

        // On node >= v0.11.12 and < 9.0 (excluding 8.9.0) https.request just calls http.request (with additional options).
        // On node < 0.11.12, 8.9.0, and 9.0 > https.request is handled separately
        // Patch both and leave a flag to not double-count on versions that just call through
        // We add the flag to both http and https to protect against strange double collection in other scenarios
        http.request = (options, ...requestArgs: any[]) => {
            const request: http.ClientRequest = originalRequest.call(http, options, ...requestArgs);
            clientRequestPatch(request, options);
            return request;
        };

        https.request = (options, ...requestArgs: any[]) => {
            const request: http.ClientRequest = originalHttpsRequest.call(https, options, ...requestArgs);
            clientRequestPatch(request, options);
            return request;
        };

        // Node 8 calls http.request from http.get using a local reference!
        // We have to patch .get manually in this case and can't just assume request is enough
        // We have to replace the entire method in this case. We can't call the original.
        // This is because calling the original will give us no chance to set headers as it internally does .end().
        http.get = (options, ...requestArgs: any[]) => {
            const request: http.ClientRequest = http.request.call(http, options, ...requestArgs);
            request.end();
            return request;
        };
        https.get = (options, ...requestArgs: any[]) => {
            const request: http.ClientRequest = https.request.call(https, options, ...requestArgs);
            request.end();
            return request;
        };
    }

    /**
     * Tracks an outgoing request. Because it may set headers this method must be called before
     * writing content to or ending the request.
     */
    public static trackRequest(client: TelemetryClient, telemetry: Contracts.NodeHttpDependencyTelemetry) {
        if (!telemetry.options || !telemetry.request || !client) {
            Logging.info("AutoCollectHttpDependencies.trackRequest was called with invalid parameters: ", !telemetry.options, !telemetry.request, !client);
            return;
        }

        let requestParser = new HttpDependencyParser(telemetry.options, telemetry.request);

        const currentContext = CorrelationContextManager.getCurrentContext();
        const uniqueRequestId = currentContext && currentContext.operation && (currentContext.operation.parentId + AutoCollectHttpDependencies.requestNumber++ + '.');

        // Add the source correlationId to the request headers, if a value was not already provided.
        // The getHeader/setHeader methods aren't available on very old Node versions, and
        // are not included in the v0.10 type declarations currently used. So check if the
        // methods exist before invoking them.
        if (Util.canIncludeCorrelationHeader(client, requestParser.getUrl()) && telemetry.request.getHeader && telemetry.request.setHeader) {
            if (client.config && client.config.correlationId) {
                const correlationHeader = telemetry.request.getHeader(RequestResponseHeaders.requestContextHeader);
                if (correlationHeader) {
                    const components = correlationHeader.split(",");
                    const key = `${RequestResponseHeaders.requestContextSourceKey}=`;
                    if (!components.some((value) => value.substring(0,key.length) === key)) {
                        telemetry.request.setHeader(
                            RequestResponseHeaders.requestContextHeader, 
                            `${correlationHeader},${RequestResponseHeaders.requestContextSourceKey}=${client.config.correlationId}`);
                    }
                } else {
                    telemetry.request.setHeader(
                        RequestResponseHeaders.requestContextHeader, 
                        `${RequestResponseHeaders.requestContextSourceKey}=${client.config.correlationId}`);
                }
            }

            if (currentContext && currentContext.operation) {
                telemetry.request.setHeader(RequestResponseHeaders.requestIdHeader, uniqueRequestId);
                // Also set legacy headers
                telemetry.request.setHeader(RequestResponseHeaders.parentIdHeader, currentContext.operation.id);
                telemetry.request.setHeader(RequestResponseHeaders.rootIdHeader, uniqueRequestId);

                const correlationContextHeader = (<PrivateCustomProperties>currentContext.customProperties).serializeToHeader();
                if (correlationContextHeader) {
                    telemetry.request.setHeader(RequestResponseHeaders.correlationContextHeader, correlationContextHeader);
                }
            }
        }

        // Collect dependency telemetry about the request when it finishes.
        if (telemetry.request.on) {
            telemetry.request.on('response', (response: http.ClientResponse) => {
                requestParser.onResponse(response);

                var dependencyTelemetry = requestParser.getDependencyTelemetry(telemetry, uniqueRequestId);
                
                dependencyTelemetry.contextObjects = dependencyTelemetry.contextObjects || {};
                dependencyTelemetry.contextObjects["http.RequestOptions"] = telemetry.options;
                dependencyTelemetry.contextObjects["http.ClientRequest"] = telemetry.request;
                dependencyTelemetry.contextObjects["http.ClientResponse"] = response;                

                client.trackDependency(dependencyTelemetry);
            });
            telemetry.request.on('error', (e: Error) => {
                requestParser.onError(e);

                var dependencyTelemetry = requestParser.getDependencyTelemetry(telemetry, uniqueRequestId);
                
                dependencyTelemetry.contextObjects = dependencyTelemetry.contextObjects || {};
                dependencyTelemetry.contextObjects["http.RequestOptions"] = telemetry.options;
                dependencyTelemetry.contextObjects["http.ClientRequest"] = telemetry.request;
                dependencyTelemetry.contextObjects["Error"] = e; 

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
