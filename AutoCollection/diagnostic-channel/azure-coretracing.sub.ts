// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
import TelemetryClient = require("../../Library/TelemetryClient");
import { channel, IStandardEvent } from "diagnostic-channel";

import Traceparent = require("../../Library/Traceparent");
import * as SpanParser from "./SpanParser";
import { Span, AsyncScopeManager, SpanKind } from "../AsyncHooksScopeManager";

let clients: TelemetryClient[] = [];

export const subscriber = (event: IStandardEvent<Span>) => {
    const span = event.data;
    const telemetry = SpanParser.spanToTelemetryContract(span);
    const spanContext = span.context();
    const traceparent = new Traceparent();
    traceparent.traceId = spanContext.traceId;
    traceparent.spanId = spanContext.spanId;
    traceparent.traceFlag = spanContext.traceFlags.toString();
    traceparent.parentId = span.parentSpanId ? `|${spanContext.traceId}.${span.parentSpanId}.` : null;

    AsyncScopeManager.with(span, () => {
        clients.forEach((client) => {
            if (span.kind === SpanKind.SERVER) {
                // Server or Consumer
                client.trackRequest(telemetry);
            } else if (span.kind === SpanKind.CLIENT || span.kind === SpanKind.INTERNAL) {
                // Client or Producer or Internal
                client.trackDependency(telemetry);
            }
            // else - ignore producer/consumer spans for now until it is clear how this sdk should interpret them
        });
    });
};

export function enable(enabled: boolean, client: TelemetryClient) {
    if (enabled) {
        if (clients.length === 0) {
            channel.subscribe<any>("azure-coretracing", subscriber);
        };
        clients.push(client);
    } else {
        clients = clients.filter((c) => c != client);
        if (clients.length === 0) {
            channel.unsubscribe("azure-coretracing", subscriber);
        }
    }
}
