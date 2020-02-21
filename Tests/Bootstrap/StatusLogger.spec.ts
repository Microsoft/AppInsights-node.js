import * as fs from "fs";
import assert = require("assert");
import sinon = require("sinon");
import path = require("path");
import os = require("os");
import { StatusLogger } from "../../Bootstrap/StatusLogger";
import { FileWriter } from "../../Bootstrap/FileWriter";

var homedir = os.homedir ? os.homedir() : (process.env[(process.platform == "win32") ? "USERPROFILE" : "HOME"]);

describe("#logStatus()", () => {
    it("should write a status file to disk", (done) => {
        const filepath = path.join(homedir, "LogFiles/ApplicationInsights/status");
        const filename = StatusLogger.DEFAULT_FILE_NAME;
        const fileWriter = new FileWriter(filepath, filename);
        if (!fileWriter["_isNodeVersionCompatible"]()) {
            done();
        } else {
            const statusLogger = new StatusLogger(fileWriter);
            statusLogger.logStatus(StatusLogger.DEFAULT_STATUS, (err: Error) => {
                assert.equal(err, null);
                const buffer = JSON.parse(fs.readFileSync(path.join(filepath, filename), "utf8"));
                assert.deepEqual(buffer, StatusLogger.DEFAULT_STATUS);
                done();
            });
        }
    });

    it("should write status to console", () => {
        const consoleStub = sinon.stub(console, "log");

        // Act
        const statusLogger = new StatusLogger(console);
        statusLogger.logStatus(StatusLogger.DEFAULT_STATUS);

        // Assert
        assert.ok(consoleStub.calledOnce);
        assert.deepEqual(consoleStub.args[0][0], StatusLogger.DEFAULT_STATUS);

        // Cleanup
        consoleStub.restore();
    });
});

// describe("#addCloseHandler()", () => {
//     it("should add a process exit handler", () => {
//         const statusLogger = new StatusLogger();
//         if (statusLogger.isNodeVersionCompatible()) {
//             const processSpy = sinon.spy(process, "on");
//             assert.ok(processSpy.notCalled);

//             statusLogger.addCloseHandler();
//             assert.equal(processSpy.callCount, 1);
//             assert.equal(processSpy.args[0][0], "exit");

//             processSpy.restore();
//         }
//     })
// });
