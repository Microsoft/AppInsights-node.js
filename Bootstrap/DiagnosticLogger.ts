"use strict";

import * as path from "path";
import * as fs from "fs";
import * as DataModel from "./DataModel";
import { FileWriter } from "./FileWriter";
import { homedir } from "./Helpers/FileHelpers";

export class DiagnosticLogger {
    public static readonly DEFAULT_FILE_NAME: string = "application-insights-extension.log";
    public static readonly DEFAULT_LOG_DIR: string = process.env.APPLICATIONINSIGHTS_LOGDIR || path.join(homedir, "LogFiles/ApplicationInsights");
    public static DefaultEnvelope: DataModel.DiagnosticLog = {
        message: null,
        level: null,
        time: null,
        logger: "nodejs.applicationinsights",
        properties: {}
    }

    constructor(private _writer: DataModel.AgentLogger = console) {}

    logMessage(message: DataModel.DiagnosticLog | string, cb?: (err: Error) => void) {
        if (typeof cb === "function" && this._writer instanceof FileWriter) {
            this._writer.callback = cb;
        }
        if (typeof message === "string") {
            const diagnosticMessage: DataModel.DiagnosticLog = {
                ...DiagnosticLogger.DefaultEnvelope,
                message,
                level: DataModel.SeverityLevel.INFO,
                time: new Date().toUTCString()
            };
            this._writer.log(diagnosticMessage);
        } else {
            if (message.level === DataModel.SeverityLevel.ERROR) {
                this._writer.error(message);
            } else {
                this._writer.log(message);
            }
        }
    }

    logError(message: DataModel.DiagnosticLog | string, cb?: (err: Error) => void) {
        if (typeof cb === "function" && this._writer instanceof FileWriter) {
            this._writer.callback = cb;
        }
        if (typeof message === "string") {
            const diagnosticMessage: DataModel.DiagnosticLog = {
                ...DiagnosticLogger.DefaultEnvelope,
                message,
                level: DataModel.SeverityLevel.ERROR,
                time: new Date().toUTCString()
            };
            this._writer.error(diagnosticMessage);
        } else {
            this._writer.error(message);
        }
    }
}
