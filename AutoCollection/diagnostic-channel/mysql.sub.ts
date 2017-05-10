// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
import Client = require("../../Library/Client");
import {channel, IStandardEvent} from "diagnostic-channel";

import {mysql} from "diagnostic-channel-publishers";

let clients: Client[] = [];

export const subscriber = (event: IStandardEvent<mysql.IMysqlData>) => {
    clients.forEach((client) => {
        const queryObj = event.data.query || {};
        const sqlString = queryObj.sql || "Unknown query";
        const success = !event.data.err;

        const connection = queryObj._connection || {};
        const connectionConfig = connection.config || {};
        const dbName = connectionConfig.socketPath ? connectionConfig.socketPath : `${connectionConfig.host || "localhost"}:${connectionConfig.port}`;
        client.trackDependency(
                dbName,
                sqlString,
                event.data.duration | 0,
                success,
                "mysql");
    });
};

export function enable(enabled: boolean, client: Client) {
    if (enabled) {
        if (clients.length === 0) {
            channel.subscribe<mysql.IMysqlData>("mysql", subscriber);
        };
        clients.push(client);
    } else {
        clients = clients.filter((c) => c != client);
        if (clients.length === 0) {
            channel.unsubscribe("mysql", subscriber);
        }
    }
}