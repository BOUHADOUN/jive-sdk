var jive = require('../../../jive-sdk'),
    assert = require('assert'),
    testUtil = require('../test-util'),
    testRunner = require('../node-test-runner'),
    q = require('q');

var integrationConfig = jive.service.options;

var host = integrationConfig['clientUrl'];
var port = integrationConfig['port'];
var base = host + ":" + port;
var jiveIdServerProc = null;
var fakeApiGatewayProc = null;

//Data for fake Jive ID server
var jiveIdPort = port + 1;
var jiveIdBase = host + ":" + jiveIdPort;

var jiveIdServerConfig = {
    clientUrl: host,
    port: jiveIdPort,
    serverType: 'jiveIdServer',
    serverName: 'Fake Jive ID Server',
    tokenResponses: {

    }
}

var setEnvironmentConfig = {
    "type": "setEnv",
    "env": {
        'jive_jiveid_servers_public': jiveIdBase,
        'jive.logging.level': 'DEBUG'
    }
}

var addTaskConfig = {
    "type": "addTask"
};

//Data for fake Jive Server
var fakeApiGatewayPort = port + 2;
var fakeApiGatewayUrl = host + ":" + fakeApiGatewayPort;

var fakeApiGatewayConfig = {
    clientUrl: host,
    port: fakeApiGatewayPort,
    serverType: 'fakeApiGateway',
    serverName: 'Fake Jive Instance Server'
}

var dataPath = "/api/jivelinks/v1/tiles/1234/data";
var dataUrl = fakeApiGatewayConfig['clientUrl'] + ":" + fakeApiGatewayConfig['port'] + dataPath;

var dataPushEndpoint = {
    "type": "setEndpoint",
    "method": "PUT",
    "path": dataPath,
    "statusCode": 204,
    "body": "",
    "headers": { "Content-Type": "application/json" }
};

var basicAuth = testUtil.makeBasicAuth(integrationConfig.clientId, integrationConfig.clientSecret);

var registrationRequest =
{
    "code": integrationConfig.clientSecret,
    "name": "sampletable",
    "config": {"config": "value"},
    "url": fakeApiGatewayUrl + dataPushEndpoint.path,
    "guid": testUtil.makeGuid(fakeApiGatewayUrl, true, 1234)
}


//************************MOCHA TESTS************************
describe('Full Cycle Tests', function () {

    //Configure mock Jive ID server first. Call done() on completion for mocha to be happy
    before(function (done) {
        testUtil.createServer(jiveIdServerConfig)
            .then(function (serverProc) {
                jiveIdServerProc = serverProc;
                return testUtil.sendOperation(setEnvironmentConfig, testRunner.serverProcess());
            })
            .thenResolve(testUtil.createServer(fakeApiGatewayConfig))
            .then(function (serverProc) {
                fakeApiGatewayProc = serverProc;
                return testUtil.sendOperation(dataPushEndpoint, serverProc);
            })
            .then(function () {
                done();
            });
    });

    beforeEach(function (done) {
        testUtil.clearInstances(testRunner.serverProcess()).then(function () {
            done();
        });
    });

    after(function (done) {
        testUtil.stopServer(jiveIdServerProc)
            .thenResolve(testUtil.stopServer(fakeApiGatewayProc))
            .then(done);
    });

    describe("All Full Cycle Tests", function () {

        it("Full cycle registration - register and push data", function (done) {
            var taskKey = null;

            testUtil.sendOperation(addTaskConfig, testRunner.serverProcess()).then(function (m) {
                taskKey = m['task'];
                var promise = testUtil.waitForMessage(testRunner.serverProcess(), 'pushedData');
                testUtil.post(base + "/registration", 201, null, registrationRequest, {"Authorization": basicAuth}, true);
                return promise;

            }).then(function (res) {
                    if (res.statusCode != 204) {
                        assert.fail(res.statusCode, 204, "Expected datapush to be successful, return 204");
                    }

                    return testUtil.sendOperation({"type": "removeTask", "task": taskKey}, testRunner.serverProcess());
                })
                .then(function () {
                    done();
                });
        });

        it("Full cycle registration - access token exchange", function (done) {

            var dataPushFailEndpoint = {
                "type": "setEndpoint",
                "method": "PUT",
                "path": "/api/jivelinks/v1/tiles/1234/data",
                "statusCode": 401,
                "body": "",
                "headers": { "Content-Type": "application/json" }
            };

            var taskKey = null;

            testUtil.sendOperation(dataPushFailEndpoint, fakeApiGatewayProc)
                .then(function () {
                    return testUtil.sendOperation(addTaskConfig, testRunner.serverProcess());
                })
                .then(function (m) {
                    taskKey = m['task'];
                    var promise1 = testUtil.waitForMessageValue(jiveIdServerProc, 'oauth2TokenRequest', {'grant_type': 'authorization'});
                    var promise2 = testUtil.waitForMessageValue(jiveIdServerProc, 'oauth2TokenRequest', {'grant_type': 'refresh_token'});
                    testUtil.post(base + "/registration", 201, null, registrationRequest, {"Authorization": basicAuth}, true);
                    return q.all[promise1, promise2];
                })
                .then(function () {
                    return testUtil.sendOperation(dataPushEndpoint, fakeApiGatewayProc);   //Configure the endpoint back to return 204 on data push
                })
                .then(function () {
                    return testUtil.waitForMessage(testRunner.serverProcess(), 'pushedData');
                })
                .then(function (res) {
                    if (res.statusCode != 204) {
                        assert.fail(res.statusCode, 204, "Expected datapush to be successful, return 204");
                    }
                    return testUtil.sendOperation({"type": "removeTask", "task": taskKey}, testRunner.serverProcess())
                })
                .then(function () {
                    done();
                });

        });

        it("Register tile and verify it is found with jive.tiles.findByID()", function (done) {

            var tileId;

            testUtil.registerTile(integrationConfig, 'sampletable', dataUrl)
                .then(function (id) {
                    tileId = id;
                    return testUtil.findTile(testRunner.serverProcess(), tileId);
                })
                .then(function (tile) {
                    if (tile) {
                        console.log('Found tile %s', JSON.stringify(tile));
                    }
                    else {
                        assert.fail(tile, true, 'Expected tile to exist for ID ' + tileId);
                    }
                })
                .then(function () {
                    done();
                });

        });

        it("Full cycle - verify tile is deleted if gateway returns 410 gone response", function (done) {

            var goneEndpoint = {
                "type": "setEndpoint",
                "method": "PUT",
                "path": dataPath,
                "statusCode": 410,
                "body": "",
                "headers": { "Content-Type": "application/json" }
            };

            var taskKey = null;
            var tileId = null;

            testUtil.sendOperation(goneEndpoint, fakeApiGatewayProc)
                .then(function () {
                    return testUtil.registerTile(integrationConfig, 'sampletable', dataUrl);
                })
                .then(function (id) {
                    tileId = id;
                    return testUtil.findTile(testRunner.serverProcess(), tileId);
                })
                .then(function (tile) {
                    if (!tile) {
                        assert.fail(tile, true, 'Expected tile to exist for ID ' + tileId);
                    }
                })
                .then(function (m) {
                    //Start waiting for pushedData message
                    var waitForPush = testUtil.waitForMessage(testRunner.serverProcess(), 'pushedData');
                    //Then kick off the task so that data will be pushed
                    var waitForTask = testUtil.sendOperation(addTaskConfig, testRunner.serverProcess()).then(function(m){
                        taskKey = m['task'];
                    });
                    return q.all([waitForPush, waitForTask]); //After both are complete, tile should have been deleted
                })
                .then(function() {
                    return testUtil.findTile(testRunner.serverProcess(), tileId);
                })
                .then(function(tile){
                    if (tile !== null) {
                        assert.fail(tile, null, 'Expected tile to NOT exist after deleting for ID ' + tileId);
                        console.log("Tile shouldn't exist %s", JSON.stringify(tile));
                    }
                })
                .then(function() {
                    return testUtil.sendOperation({"type": "removeTask", "task": taskKey}, testRunner.serverProcess());
                })
                .then(function () {
                    done();
                });

        });
    });
});


