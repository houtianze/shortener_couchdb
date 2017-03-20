/*jshint node: true */
/*jshint esversion: 6 */
'use strict';

var express = require("express");
var app = express();
var cfenv = require("cfenv");
var bodyParser = require('body-parser');
var _ = require("underscore");

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());

//database name
const dbName = 'mydb';
var mydb;
var nextId = -1;

// utils

function encode62(num) {
  var table = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var len = table.length;
  var ra = [];
  while (num !== 0) {
    ra.unshift(table[num % len]);
    num = Math.floor(num / len);
  }
  ra.reverse();
  return ra.join('');
}

function decode62(enc) {
  var num = 0;
  var len = enc.length;
  for (var i = 0; i < len; i++) {
    var c = enc.charAt(len - 1 - i);
    var val = 0;
    if (c >= '0' && c <= '9') {
      val = c - '0';
    } else if (c >= 'a' && c <= 'z') {
      val = 10 + c - 'a';
    } else if (c >= 'A' && c <= 'Z') {
      val = 36 + c - 'A';
    } else {
      return -1;
    }
    num += val * Math.pow(62, i);
  }
  return num;
}

function createIndex(cb) {
  var query = {
    index: {
      "fields": ["id"]
    },
    name: "id-index"
  };
  cloudant.request({
    db: dbName,
    method: 'POST',
    doc: '_index',
    body: query,
  }, cb);
  query = {
    index: {
      "fields": ["url"]
    },
    name: "url-index"
  };
  cloudant.request({
    db: dbName,
    method: 'POST',
    doc: '_index',
    body: query,
  }, cb);
}

function getMaxId(cb) {
  var query = {
    selector: {},
    fields: ["id"],
    sort: [{ "id": "desc" }],
    limit: 1
  };
  cloudant.request({
    db: dbName,
    method: 'POST',
    doc: '_find',
    body: query,
  }, cb);
}

function checkUrl(url, cb) {
  var query = {
    selector: { "url": url },
    limit: 1
  };
  cloudant.request({
    db: dbName,
    method: 'POST',
    doc: '_find',
    body: query,
  }, cb);
}

function checkId(id, cb) {
  var query = {
    selector: { "id": id },
    limit: 1
  };
  cloudant.request({
    db: dbName,
    method: 'POST',
    doc: '_find',
    body: query,
  }, cb);
}

/*
Create or get existing short url:
POST /api/shorten?longUrl=google.com
*/
app.post("/api/shorten", function (req, res) {
  var longUrl = req.query.longUrl;
  if (_.isEmpty(longUrl)) {
    res.status(400).send("Parameter 'longUrl' not specified");
    return;
  }

  if (!mydb) {
    var em = "No database";
    console.log(em);
    res.status(500).send(em);
    return;
  }

  checkUrl(longUrl, function (err, body, header) {
    if (err) {
      console.log(err);
      res.status(500).send(err);
      return;
    }
    if (body.docs.length > 0) {
      var id = body.docs[0].id;
      res.send({ "status": "existing", "id": encode62(id) });
      return;
    }
    if (nextId > 0) {
      mydb.insert({ "id": nextId, "url": longUrl });
      res.send({ "status": "inserted", "id": encode62(nextId) });
      nextId++;
    } else {
      res.status(500).send("Sorry, database not ready yet, please try again later.");
    }
  });
});

/*
Redirect short url to the original long url
GET /api/redirect/ab
*/
app.get("/api/redirect/:encid", function (req, res) {
  var encid = req.params.encid;
  var id = decode62(encid);
  checkId(id, function (err, body, header) {
    if (err) {
      res.status(500).send(err);
      return;
    }
    if (body.docs.length <= 0) {
      res.status(400).send("Short URL '" + encid+ "' not found");
      return;
    }
    var loc = body.docs[0].url;
    //res.writeHead(301, { Location: loc});
    //res.location(loc);
    res.type('html');
    var html = `
    <html>
    <head>
        <meta http-equiv="refresh" content="3;url='`;
    html += loc + '\'" />';
    html += `<script>
  (function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){
  (i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),
  m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)
  })(window,document,'script','https://www.google-analytics.com/analytics.js','ga');

  ga('create', 'UA-93994325-1', 'auto');
  ga('send', 'pageview');

    </script>
        </head>
    <body>
        <h1>Redirecting in 3 seconds...</h1>
    </body>
    </html>
    `;
    res.send(html);
  });
});


// load local VCAP configuration  and service credentials
var vcapLocal;
try {
  vcapLocal = require('./vcap-local.json');
  console.log("Loaded local VCAP", vcapLocal);
} catch (e) { }

const appEnvOpts = vcapLocal ? { vcap: vcapLocal } : {};

const appEnv = cfenv.getAppEnv(appEnvOpts);

if (appEnv.services['cloudantNoSQLDB']) {
  // Load the Cloudant library.
  var Cloudant = require('cloudant');

  // Initialize database with credentials
  var cloudant = Cloudant(appEnv.services['cloudantNoSQLDB'][0].credentials);

  // Create a new "mydb" database.
  cloudant.db.create(dbName, function (err, data) {
    if (!err) //err if database doesn't already exists
      console.log("Created database: " + dbName);
  });

  createIndex(function(err, body, header) {
  });
  // Specify the database we are going to use (mydb)...
  mydb = cloudant.db.use(dbName);
  getMaxId(function (err, body, header) {
    if (err) {
      console.log(err);
      process.exit(1);
    }
    var id = 0;
    if (body.docs.length >=0 && ! _.isEmpty(body.docs[0])) {
      id = body.docs[0].id;
    }
    nextId = id + 1;
  });
}

//serve static file (index.html, images, css)
app.use(express.static(__dirname + '/views'));

var port = process.env.PORT || 3000;
app.listen(port, function () {
  console.log("To view your app, open this link in your browser: http://localhost:" + port);
});
