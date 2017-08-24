// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
import Client = require("../../Library/Client");
import {channel, IStandardEvent} from "diagnostic-channel";

import {pg} from "diagnostic-channel-publishers";

let clients: Client[] = [];

export const subscriber = (event: IStandardEvent<pg.IPostgresData>) => {
    clients.forEach((client) => {
        const q = event.data.query;
        const sql = q.preparable.text || q.plan || q.text || "unknown query";
        const success = !event.data.error;
        const conn = `${event.data.database.host}:${event.data.database.port}`;
        client.trackDependency(
                conn,
                sql,
                event.data.duration | 0,
                success,
                "postgres");
    });
};

export function enable(enabled: boolean, client: Client) {
    if (enabled) {
        if (clients.length === 0) {
            channel.subscribe<pg.IPostgresData>("postgres", subscriber);
        };
        clients.push(client);
    } else {
        clients = clients.filter((c) => c != client);
        if (clients.length === 0) {
            channel.unsubscribe("postgres", subscriber);
        }
    }
}
