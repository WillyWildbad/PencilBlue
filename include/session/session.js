/*
    Copyright (C) 2016  PencilBlue, LLC

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
'use strict';

//dependencies
var Configuration = require('../config');
var crypto = require('crypto');
var log = require('../utils/logging').newInstance('SessionHandler');
var path   = require('path');
var uuid = require('uuid');

/**
 * Tools for session storage
 *
 * @module Session
 */
module.exports = function SessionModule(pb) {//TODO [1.0] make consistent with .load like cache module.  Maybe abstract file load with variable paths

    /**
     * Responsible for managing user sessions
     * @param {SessionStore} sessionStore
     */
    class SessionHandler {
        constructor(sessionStore) {

            //ensure a session store was started
            this.sessionStore = sessionStore;
        }

        /**
         *
         * @readonly
         * @type {String}
         */
        static get HANDLER_PATH() {
            return path.join(Configuration.activeConfiguration.docRoot, 'include', 'session', 'storage', path.sep);
        }

        /**
         *
         * @readonly
         * @type {String}
         */
        static get HANDLER_SUFFIX() {
            return '_session_store.js';
        }

        /**
         *
         * @readonly
         * @type {String}
         */
        static get SID_KEY() {
            return 'uid';
        }

        /**
         *
         * @static
         * @readonly
         * @property TIMEOUT_KEY
         * @type {String}
         */
        static get TIMEOUT_KEY() {
            return 'timeout';
        }

        /**
         *
         * @static
         * @readonly
         * @property COOKIE_HEADER
         * @type {String}
         */
        static get COOKIE_HEADER() {
            return 'parsed_cookies';
        }


        /**
         *
         * @static
         * @readonly
         * @property COOKIE_NAME
         * @type {String}
         */
        static get COOKIE_NAME() {
            return 'session_id';
        }

        /**
         *
         * @method start
         * @param {Function} cb
         */
        start (cb) {
            this.sessionStore.start(cb);
        }

        /**
         * Retrieves a session for the current request.  When the session ID is
         * available the existing session is retrieved otherwise a new session is
         * created.
         * @param {Object} request The request descriptor
         * @param {Function} cb The callback(ERROR, SESSION_OBJ)
         */
        open(request, cb) {

            //check for active
            var sid = SessionHandler.getSessionIdFromCookie(request);
            if (!sid) {
                return cb(null, this.create(request));
            }

            //session not available locally so check persistent storage
            var handler = this;
            this.sessionStore.get(sid, function (err, result) {
                if (err || result) {
                    return cb(err, result);
                }

                //session not found create one
                cb(null, handler.create(request));
            });
        }

        /**
         * Closes the session and persists it when no other requests are currently
         * accessing the session.
         * @param {Object} session
         * @param {Function} cb
         */
        close(session, cb) {
            if (!session) {
                throw new Error("SessionHandler: Cannot close an empty session");
            }

            if (typeof session !== 'object') {
                throw new Error("SessionHandler: The session has not been opened or is already closed");
            }

            //update timeout
            session[SessionHandler.TIMEOUT_KEY] = new Date().getTime() + Configuration.activeConfiguration.session.timeout;

            //last active request using this session, persist it back to storage
            if (session.end) {
                this.sessionStore.clear(session.uid, cb);
            }
            else {
                this.sessionStore.set(session, cb);
            }

            //another request is using the session object so just call back OK
            cb(null, true);
        }

        /**
         * Sets the session in a state that it should be terminated after the last request has completed.
         * @param {Object} session
         * @param {Function} cb
         */
        end(session, cb) {
            session.end = true;
            cb(null, true);
        }

        /**
         * Creates the shell of a session object
         * @param request
         * @return {Object} Session
         */
        create(request) {
            var session = {
                authentication: {
                    user_id: null,
                    permissions: [],
                    admin_level: pb.SecurityService.ACCESS_USER
                },
                ip: request.connection.remoteAddress,
                client_id: SessionHandler.getClientId(request)
            };
            session[SessionHandler.SID_KEY] = uuid.v4();
            return session;
        }

        /**
         * Shuts down the sesison handler and the associated session store
         * @method shutdown
         * @param {Function} cb
         */
        shutdown() {
            return this.sessionStore.shutdown();
        }

        /**
         * Generates a unique client ID based on the user agent and the remote address.
         * @static
         * @method getClientId
         * @param {Object} request
         * @return {String} Unique Id
         */
        static getClientId(request) {
            var whirlpool = crypto.createHash('whirlpool');
            whirlpool.update(request.connection.remoteAddress + request.headers['user-agent']);
            return whirlpool.digest('hex');
        }

        /**
         * Loads a session store prototype based on the system configuration
         * @static
         * @method getSessionStore
         * @return {Function}
         */
        static getSessionStore() {
            var possibleStores = [
                SessionHandler.HANDLER_PATH + Configuration.activeConfiguration.session.storage + SessionHandler.HANDLER_SUFFIX,
                Configuration.activeConfiguration.session.storage
            ];

            var SessionStoreModule = null;
            for (var i = 0; i < possibleStores.length; i++) {
                try {
                    SessionStoreModule = require(possibleStores[i]);
                    break;
                }
                catch (e) {
                    log.silly('SessionHandler: Failed to load %s: %s', possibleStores[i], e.stack);
                }
            }

            //ensure session store was loaded
            if (SessionStoreModule === null) {
                throw new Error("Failed to initialize a session store. Exhausted posibilities: " + JSON.stringify(possibleStores));
            }
            return SessionStoreModule(pb);
        }

        /**
         * Retrieves an instance of the SessionStore specified in the sytem configuration
         * @static
         * @method getSessionStore
         * @return {SessionStore}
         */
        static getSessionStoreInstance() {
            var SessionStorePrototype = SessionHandler.getSessionStore();
            return new SessionStorePrototype();
        }

        /**
         * Extracts the session id from the returned cookie
         * @static
         * @method getSessionIdFromCookie
         * @param {Object} request The object that describes the incoming user request
         * @return {string} Session Id if available NULL if it cannot be found
         */
        getSessionIdFromCookie(request) {

            var sessionId = null;
            if (request.headers[SessionHandler.COOKIE_HEADER]) {

                // Discovered that sometimes the cookie string has trailing spaces
                for (var key in request.headers[SessionHandler.COOKIE_HEADER]) {
                    if (key.trim() === 'session_id') {
                        sessionId = request.headers[SessionHandler.COOKIE_HEADER][key];
                        break;
                    }
                }
            }
            return sessionId;
        }

        /**
         *
         * @static
         * @method getSessionCookie
         * @param {Object} session
         * @return {Object}
         */
        static getSessionCookie(session) {
            return {session_id: session.uid, path: '/'};
        }
    }

    return SessionHandler;
};
