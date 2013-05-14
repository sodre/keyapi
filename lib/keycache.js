/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Key cache / private key object
 */

var sdc = require('sdc-clients');
var ldap = require('ldapjs');
var parseDN = ldap.parseDN;
var util = require('util');
var assert = require('assert-plus');
var sprintf = require('sprintf').sprintf;
var vasync = require('vasync')

var CHANGELOG = 'cn=changelog';
var KEYAPIPRIVKEY_DN = 'ou=keyapiprivkeys, o=smartdc';

function keycache(options) {
  assert.ok(options.ufds);

  var self = this;

  self.keys = {};
  self.latestkey = undefined;

  // populate keys
  self.ufds = new sdc.UFDS(options.ufds);
  self.ufds.on('ready', function() {
  var opts = {
    scope: "sub",
    filter: "(objectclass=keyapiprivkey)"
  };
  self.ufds.search("ou=keyapiprivkeys, o=smartdc", opts, function(err, entries) {
      if (err)
        throw err;
      for (var i = 0; i < entries.length; i++) {
        self.keys[entries[i].uuid] = entries[i];
      }
      self.getLatest(self);
    });

  /*
   * poll needs lower-level access to UFDS, not the convenience
   * functions of sdc-clients
   */
    self.ldapClient = ldap.createClient(options.ufds);
    self.pollInterval = options.pollInterval;
    self.changenumber = 0;
    self.timeout = options.ufds.timeout || self.pollInterval / 2;
    self.queue = vasync.queue(parseEntry, 1);
    self.currPolling = false;

    setInterval(self.poll, self.pollInterval, self);
  });
};

module.exports.keycache = keycache;

function poll() {
  if (self.currPolling) {
    return;
  }
  self.currPolling = true;
  var start = parseInt(self.changenumber);

  var latestchange = self.changenumber;

  /* JSSTYLED */
  var filter = sprintf('(&(changenumber>=%s)(targetdn=*ou=keyapiprivkeys*))', start);
  var opts = {
    scope: 'sub',
    filter: filter
  }
  var entries = [];
  var timeoutId = setTimeout(self.onTimeout, self.timeout);

  self.ldapClient.search(CHANGELOG, opts, function(err, res) {
    timeoutId._ldapRes = res;

    if (err) {
      clearTimeout(timeoutId);
      self.currPolling = false;
      return;
    }

    res.on('searchEntry', function(entry) {
      clearTimeout(timeoutId);

      var changenumber = parseInt(entry.object.changenumber);
      if (changenumber > self.changenumber) {
        latestchange = changenumber
      }

      var targetdn = parseDN(entry.object.targetdn);
      var changes = JSON.parse(entry.object.changes);

      if (targetdn.childOf(KEYAPIPRIVKEY_DN) {
        if (changes && changes.objectclass) {
          var objectclass = changes.objectclass[0];
          if (objectclass == 'keyapiprivkey') {
            entry.parsedChanges = changes;
            entries.push(entry);
          }
        }
      }

    });
    res.on('end', function(res2) {
      clearTimeout(timeoutId);
      if (entries.length === 0) { 
        if (self.changenumber < latestchange)
          self.changenumber = latestchange + 1;
        self.currPolling = false;
      }
      entries.forEach(function(entry, index) {
        var uuid = entry.parsedChanges.uuid[0];
        if (!uuid)
          return;
        if (self.keys[uuid])
          assert.ok(self.keys[uuid]['key'] == entry.parsedChanges.key[0]);
          var obj = {
            uuid: entry.parsedChanges.uuid[0]
            key: entry.parsedChanges.key[0]
            timestamp: new Date(entry.parsedChanges.timestamp[0])
          };
          self.keys[uuid] = obj;
      });
    });
    res.on('error', function(err2) { });
  });

};

keycache.prototype.poll = poll;
