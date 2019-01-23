import { CorrelationContextManager, CorrelationContext } from "../../AutoCollection/CorrelationContextManager";

import assert = require("assert");
import sinon = require("sinon");

const customProperties = {
    getProperty(prop: string) {return ""},
    setProperty(prop: string, val: string) {},
}

if (CorrelationContextManager.isNodeVersionCompatible()) {
    describe("AutoCollection/CorrelationContextManager", () => {
        var testContext: CorrelationContext = {
            operation: {
                id: "test",
                name: "test",
                parentId: "test"
            },
            customProperties
        };
        var testContext2: CorrelationContext = {
            operation: {
                id: "test2",
                name: "test2",
                parentId: "test2"
            },
            customProperties
        };
        describe("#enable", () => {
            beforeEach(() => {
                (CorrelationContextManager as any).hasEverEnabled = false;
                (CorrelationContextManager as any).cls = undefined;
                CorrelationContextManager.disable();
            });
            afterEach(() => {
                (CorrelationContextManager as any).hasEverEnabled = false;
                (CorrelationContextManager as any).cls = undefined;
                CorrelationContextManager.disable();
            });

            it("should use cls-hooked if force flag is set to true", () => {
                if (CorrelationContextManager.canUseClsHooked()){
                    CorrelationContextManager.enable(true);
                    assert.deepEqual((CorrelationContextManager as any).cls, require('cls-hooked'), 'cls-hooked is loaded');
                    assert.notDeepEqual((CorrelationContextManager as any).cls, require('continuation-local-storage'));
                }
            });
            it("should use continuation-local-storage if force flag is set to false", () => {
                CorrelationContextManager.enable(false);
                assert.deepEqual((CorrelationContextManager as any).cls, require('continuation-local-storage'), 'cls is loaded');
                if (CorrelationContextManager.canUseClsHooked()) {
                    assert.notDeepEqual((CorrelationContextManager as any).cls, require('cls-hooked'));
                }
            });
            it("should pick correct version of cls based on node version", () => {
                CorrelationContextManager.enable();
                if (CorrelationContextManager.shouldUseClsHooked()) {
                    assert.deepEqual((CorrelationContextManager as any).cls, require('cls-hooked'), 'cls-hooked is loaded');
                    assert.notDeepEqual((CorrelationContextManager as any).cls, require('continuation-local-storage'));
                } else {
                    assert.deepEqual((CorrelationContextManager as any).cls, require('continuation-local-storage'), 'cls is loaded');
                    if (CorrelationContextManager.canUseClsHooked()) {
                        assert.notDeepEqual((CorrelationContextManager as any).cls, require('cls-hooked'));
                    }
                }
            });
        });

        describe("#getCurrentContext()", () => {
            afterEach(() => {
              // Mocha's async "done" methods cause future tests to be in the same context chain
              // Reset the context each time
              CorrelationContextManager.reset();
              assert.equal(null, CorrelationContextManager.getCurrentContext());
            });
            it("should return null if not in a context", () => {
                CorrelationContextManager.enable();

                assert.equal(CorrelationContextManager.getCurrentContext(), null);
            });
            it("should return null if the ContextManager is disabled (outside context)", () => {
                CorrelationContextManager.disable();

                assert.equal(CorrelationContextManager.getCurrentContext(), null);
            });
            it("should return null if the ContextManager is disabled (inside context)", (done) => {
                CorrelationContextManager.enable();

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    CorrelationContextManager.disable();
                    assert.equal(CorrelationContextManager.getCurrentContext(), null);
                    done();
                });
            });
            it("should return the context if in a context", (done) => {
                CorrelationContextManager.enable();

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    assert.equal(CorrelationContextManager.getCurrentContext(), testContext);
                    done();
                });
            });
            it("should return the context if called by an asynchronous callback in a context", (done) => {
                CorrelationContextManager.enable();

                CorrelationContextManager.runWithContext(testContext2, ()=>{
                    process.nextTick(()=>{
                        assert.equal(CorrelationContextManager.getCurrentContext(), testContext2);
                        done();
                    });
                });
            });
            it("should return the correct context to asynchronous callbacks occuring in parallel", (done) => {
                CorrelationContextManager.enable();

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    process.nextTick(()=>{
                        assert.equal(CorrelationContextManager.getCurrentContext(), testContext);
                    });
                });

                CorrelationContextManager.runWithContext(testContext2, ()=>{
                    process.nextTick(()=>{
                        assert.equal(CorrelationContextManager.getCurrentContext(), testContext2);
                    });
                });

                setTimeout(()=>done(), 10);
            });
        });

        describe("#AppInsightsAsyncCorrelatedErrorWrapper", () => {
            it("should not crash if prepareStackTrace is used", () => {
                CorrelationContextManager.enable();

                try {
                    var stackTrace = (<any>Error)['prepareStackTrace'];
                    (<any>Error)['prepareStackTrace'] = function (_: any, stack: any) {
                        (<any>Error)['prepareStackTrace'] = stackTrace;
                        return stack;
                    };

                    var error = new Error();
                    assert(<any>error.stack instanceof Array);
                } catch (e) {
                    assert(false);
                }
            });
            it("should remove extra AI+Zone methods if prepareStackTrace is used", () => {
                CorrelationContextManager.enable();

                var stackTrace = (<any>Error)['prepareStackTrace'];
                (<any>Error)['prepareStackTrace'] = function (_: any, stack: any) {
                    (<any>Error)['prepareStackTrace'] = stackTrace;
                    return stack;
                };

                var error = new Error();
                var topOfStack = (<any>error.stack)[0].getFileName();
                assert(topOfStack.indexOf("CorrelationContextManager.tests.js") !== -1, "Top of stack not expected to be " + topOfStack);
            });
            it("should not crash on missing filename", () => {
                CorrelationContextManager.enable();

                var stackTrace = (<any>Error)['prepareStackTrace'];
                (<any>Error)['prepareStackTrace'] = function (_: any, stack: any): any[] {
                    return stack;
                };

                var error = new Error();
                try {
                    (<any>Error)['prepareStackTrace'](null, [{getFunctionName: ()=>'', getFileName: ():any=>null}]);
                    (<any>Error)['prepareStackTrace'] = stackTrace;
                } catch (e) {
                    (<any>Error)['prepareStackTrace'] = stackTrace;
                    assert(false, "prepareStackTrace should not throw. Threw: " + e);
                }
            });
        });

        describe("#runWithContext()", () => {
            it("should run the supplied function", () => {
                CorrelationContextManager.enable();
                var fn = sinon.spy();

                CorrelationContextManager.runWithContext(testContext, fn);

                assert(fn.calledOnce);
            });
        });

        describe("#wrapCallback()", () => {
            it("should return the supplied function if disabled", () => {
                CorrelationContextManager.disable();
                var fn = sinon.spy();

                var wrapped = CorrelationContextManager.wrapCallback(fn);

                assert.equal(wrapped, fn);
            });
            it("should return a function that calls the supplied function if enabled", () => {
                CorrelationContextManager.enable();
                var fn = sinon.spy();

                var wrapped = CorrelationContextManager.wrapCallback(fn);
                wrapped();

                assert.notEqual(wrapped, fn);
                assert(fn.calledOnce);
            });
            it("should return a function that restores the context available at call-time into the supplied function if enabled", (done) => {
                CorrelationContextManager.enable();

                var sharedFn = ()=> {
                    assert.equal(CorrelationContextManager.getCurrentContext(), testContext);
                };

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    sharedFn = CorrelationContextManager.wrapCallback(sharedFn);
                });

                CorrelationContextManager.runWithContext(testContext2, ()=>{
                    setTimeout(()=>{
                        sharedFn();
                    }, 8);
                });

                setTimeout(()=>done(), 10);
            });
        });
    });
} else {
    describe("AutoCollection/CorrelationContextManager[IncompatibleVersion!]", () => {
        var testContext: CorrelationContext = {
            operation: {
                id: "test",
                name: "test",
                parentId: "test"
            },
            customProperties
        };
        var testContext2: CorrelationContext = {
            operation: {
                id: "test2",
                name: "test2",
                parentId: "test2"
            },
            customProperties
        };

        describe("#getCurrentContext()", () => {
            it("should return null if not in a context", () => {
                CorrelationContextManager.enable();

                assert.equal(CorrelationContextManager.getCurrentContext(), null);
            });
            it("should return null if the ContextManager is disabled (outside context)", () => {
                CorrelationContextManager.disable();

                assert.equal(CorrelationContextManager.getCurrentContext(), null);
            });
            it("should return null if the ContextManager is disabled (inside context)", (done) => {
                CorrelationContextManager.enable();

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    CorrelationContextManager.disable();
                    assert.equal(CorrelationContextManager.getCurrentContext(), null);
                    done();
                });
            });
            it("should return null if in a context", (done) => {
                CorrelationContextManager.enable();

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    assert.equal(CorrelationContextManager.getCurrentContext(), null);
                    done();
                });
            });
            it("should return null if called by an asynchronous callback in a context", (done) => {
                CorrelationContextManager.enable();

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    process.nextTick(()=>{
                        assert.equal(CorrelationContextManager.getCurrentContext(), null);
                        done();
                    });
                });
            });
            it("should return null to asynchronous callbacks occuring in parallel", (done) => {
                CorrelationContextManager.enable();

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    process.nextTick(()=>{
                        assert.equal(CorrelationContextManager.getCurrentContext(), null);
                    });
                });

                CorrelationContextManager.runWithContext(testContext2, ()=>{
                    process.nextTick(()=>{
                        assert.equal(CorrelationContextManager.getCurrentContext(), null);
                    });
                });

                setTimeout(()=>done(), 10);
            });
        });

        describe("#runWithContext()", () => {
            it("should run the supplied function", () => {
                CorrelationContextManager.enable();
                var fn = sinon.spy();

                CorrelationContextManager.runWithContext(testContext, fn);

                assert(fn.calledOnce);
            });
        });

        describe("#wrapCallback()", () => {
            it("should return the supplied function if disabled", () => {
                CorrelationContextManager.disable();
                var fn = sinon.spy();

                var wrapped = CorrelationContextManager.wrapCallback(fn);

                assert.equal(wrapped, fn);
            });
            it("should return the supplied function if enabled", () => {
                CorrelationContextManager.enable();
                var fn = sinon.spy();

                var wrapped = CorrelationContextManager.wrapCallback(fn);

                assert.equal(wrapped, fn);
            });
            it("should not return a function that restores a null context at call-time into the supplied function if enabled", (done) => {
                CorrelationContextManager.enable();

                var sharedFn = ()=> {
                    assert.equal(CorrelationContextManager.getCurrentContext(), null);
                };

                CorrelationContextManager.runWithContext(testContext, ()=>{
                    sharedFn = CorrelationContextManager.wrapCallback(sharedFn);
                });

                CorrelationContextManager.runWithContext(testContext2, ()=>{
                    setTimeout(()=>{
                        sharedFn();
                    }, 8);
                });

                setTimeout(()=>done(), 10);
            });
        });
    });
}
