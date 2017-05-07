var http = require("http");
var https = require("https");
var request = require("request");
var fs = require("fs");
var path = require('path');
var servers;
var distanceBufferMiles = 1;
var resultSize = 10;
var requestTimeoutMilliseconds = 5000;
var sortMetric = 'distance_in_miles';
var vdir = "bmltfed";
var defaultVdir = "main_server";
var ssl = {
    key: fs.readFileSync(path.join(__dirname, 'certs/bmlt-aggregator.archsearch.org.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs/bmlt-aggregator.archsearch.org.crt'))
};

http.createServer(requestReceived).listen(8888);
https.createServer(ssl, requestReceived).listen(8889);

function requestReceived(req, res) {
    console.log('request received: ' + req.url);
    if ((req.url.indexOf(vdir) < 0
        && req.url.indexOf(defaultVdir) < 0)
        || req.url.indexOf('favicon') > -1) {
        res.writeHead(404);
        res.end("404");
        return
    }

    var requestWithToken = req.url
        .substring(1)
        .replace("/" + vdir, "")
        .replace("/" + defaultVdir, "");

    var settingToken = requestWithToken
        .substring(0, requestWithToken.indexOf("/"))

    req.url = requestWithToken.replace(settingToken, "");

    getServers(settingToken).then(servers => {
        console.log("Querying " + servers.length + " servers.");

        return servers.map(server => {
            return getData(server + req.url, (req.url.indexOf("json") > -1));
        });
    }).catch(error => {
        console.error(error);
        res.writeHead(404);
        res.end("404");
        reject();
    }).then(serverQueries => {
        return executeQueries(serverQueries);
    });

    function executeQueries(serverQueries) {
        return Promise.all(serverQueries).then(data => {
            console.log("All requests received and returned.");

            if (req.url.indexOf('GetLangs.php') > -1 && req.url.indexOf('json') > -1) {
                var data = {"languages":[{"key":"en","name":"English","default":true},{"key":"de","name":"German"},{"key":"es","name":"Spanish"},{"key":"fr","name":"French"},{"key":"it","name":"Italian"},{"key":"sv","name":"Svenska"}]};
                return returnResponse(req, res, data);
            }

            // Clean up bad results from servers
            var k = data.length;
            while (k--) {
                if (data[k] == null) data.splice(k, 1)
            }

            var combined = [];
            for (var i = 0; i < data.length; i++) {
                // TODO: this is a weird bug in the BMLT where it return text/html content-type headers
                if (data[i].headers['content-type'].indexOf("application/xml") < 0) {
                    for (var j = 0; j < data[i].body.length; j++) {
                        var preIndex = i + 1;
                        if (req.url.indexOf('GetSearchResults') > -1) {
                            data[i].body[j].service_body_bigint = preIndex + data[i].body[j].service_body_bigint;
                        } else {
                            data[i].body[j].id = preIndex + data[i].body[j].id;
                            data[i].body[j].parent_id = preIndex + data[i].body[j].parent_id;
                        }

                        combined.push(data[i].body[j]);
                    }
                } else {
                    combined.push(data[i].body);
                }
            }

            // Sort search results
            if (req.url.indexOf('GetSearchResults') > -1) {
                combined = combined.sort((a, b) => {
                    return parseFloat(a[sortMetric]) - parseFloat(b[sortMetric]);
                });

                var checker = combined.slice(resultSize, combined.length - 1);
                combined.splice(resultSize, combined.length - 1);

                for (var c = 0; c < checker.length; c++) {
                    if (checker[c][sortMetric] - combined[combined.length - 1][sortMetric] <= distanceBufferMiles) {
                        combined.push(checker[c]);
                    }
                }
            }

            if (req.url.indexOf('switcher=GetServerInfo') > -1) {
                var highestVersionIndex = 0;
                var highestVersion = -1;

                for (var v = 0; v < combined.length; v++) {
                    if (highestVersion == -1 || combined[v].versionInt > highestVersion) {
                        highestVersion = combined[v].versionInt;
                        highestVersionIndex = v;
                    }
                }

                combined[highestVersionIndex].version = '4.0.0';
                combined[highestVersionIndex].versionInt = '4000000';
                combined[highestVersionIndex].semanticAdmin = '0';
                combined = combined[highestVersionIndex];
            } else if (req.url.indexOf('serverInfo') > -1) {
                combined = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<bmltInfo>\r\n<serverVersion>\r\n<readableString>4.0.0</readableString>\r\n</serverVersion>\r\n</bmltInfo>";
            } else if (req.url.indexOf('xml') > -1 || req.url.indexOf('xsd') > -1) {
                combined = combined[0];
            }

            returnResponse(req, res, combined);
        }, error => {
            res.writeHead(500);
            res.end("500");
            console.error(error);
        });
    }
}

function returnResponse(req, res, data) {
    req.url.indexOf('json') > -1 ? returnJSONResponse(res, data) : returnXMLResponse(res, data)

    return true;
}

function returnJSONResponse(res, data) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function returnXMLResponse(res, data) {
    res.writeHead(200, {'Content-Type': 'application/xml'});
    res.end(data);
}

function getServers(settingToken) {
    return new Promise((resolve, reject) => {
        var settings = process.env["BMLT_ROOT_SERVERS" + (settingToken == "_" ? "" : "_" + settingToken)];

        if (settings.indexOf("json:") == 0) {
            getData(settings.replace("json:", ""), true).then(servers => {
                var serversArray = [];
                for (var s = 0; s < servers.body.length; s++) {
                    serversArray.push(servers.body[s]["rootURL"]);
                }
                console.log(serversArray);
                resolve(serversArray);
            }).catch(error => {
                reject(error);
            });
        } else if (settings != null) {
            resolve(settings.split(","));
        } else {
            reject();
        }
    });
}

function getData(url, isJson) {
    console.log("getData(): " + url);
    return new Promise((resolve, reject) => {
        request({
            url: url,
            json: isJson,
            headers: {
                'User-Agent': 'Mozilla/4.0 (compatible; MSIE: 5.01; Windows NT 5.0)'
            },
            timeout: requestTimeoutMilliseconds
        }, (error, response, body) => {
            if (error) {
                console.error("\r\n" + url + ": " + error);
                resolve(response);
            } else {
                if (body != null) {
                    console.log("body array length: " + body.length + ", url: " + url)
                    if (body.toString().indexOf("DOCTYPE") >= 0) {
                        response.body = "";
                    }
                }
                resolve(response);
            }
        });
    });
}

function setCacheValue(key, value) {
    cache.key = key;
    cache.value = value;
    cache.timestamp = new Date;
}

function getCacheValue(key) {
    if (true) {
        return null;
    }
    return cache.data;
}

console.log("sandwich server started.");