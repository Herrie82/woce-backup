/* Which bus name is this service called on, on this device.
 *
 * The backup protocol itself is unchanged across webOS generations - services
 * still register in /etc/palm/backup and still answer preBackup/postRestore -
 * but several of the platform services the engine calls directly were renamed
 * when webOS OSE reorganised the bus. com.palm.systemservice became
 * com.webos.service.systemservice, the battery half of com.palm.power moved to
 * com.webos.service.battery, and so on. Nothing aliases the old names, so a
 * hardcoded com.palm.* constant simply fails to resolve on LuneOS - quietly,
 * because the engine tolerates a failed device-status call rather than aborting
 * a backup over it. That is how a manifest ends up with "battery": null and
 * "connections": {} and nobody notices.
 *
 * Rather than scatter the alternatives through system.js, resolve them here,
 * once, against one platform test.
 */
/*global require */

var platform = (function () {
    var that = {};
    var fs = require('fs');

    /* The test is the shape of the bus configuration, not a distro name.
     *
     * webOS 3.0.5 keeps role files under /usr/share/ls2 and knows nothing else.
     * The OSE access-control model that came with the renames adds
     * /usr/share/luna-service2/{roles,groups,api-permissions,...}.d, and its
     * presence is what actually predicts the new service names - which is the
     * question being asked. Reading /etc/os-release would test the distro's
     * name instead, and be wrong on the next fork.
     *
     * Both directories exist on LuneOS, so this must test for the new one, not
     * the absence of the old.
     */
    var isModernBus = (function () {
        try {
            fs.readdirSync("/usr/share/luna-service2/services.d");
            return true;
        } catch (err) {
            return false;
        }
    }());

    /* Logical name -> bus name, per platform.
     *
     * A null means the service does not exist on that platform at all and
     * callers must cope: com.palm.deviceprofile has no OSE counterpart, so
     * getNduId falls through to nyx instead.
     */
    var SERVICES = {
        systemservice:     { legacy: "com.palm.systemservice",
                             modern: "com.webos.service.systemservice" },
        activitymanager:   { legacy: "com.palm.activitymanager",
                             modern: "com.webos.service.activitymanager" },
        // Only ever asked for com/palm/power/batteryStatusQuery, and on the OSE
        // bus that lives on the battery daemon, not power2 (which took the
        // wakelock/shutdown half of the old service). The method path is
        // identical on both - com.webos.service.battery still answers the
        // com/palm/power/... form - so only the name moves.
        power:             { legacy: "com.palm.power",
                             modern: "com.webos.service.battery" },
        connectionmanager: { legacy: "com.palm.connectionmanager",
                             modern: "com.webos.service.connectionmanager" },
        deviceprofile:     { legacy: "com.palm.deviceprofile",
                             modern: null },

        // Unchanged on both, listed so every service the engine talks to is
        // findable from one place rather than half here and half inline.
        db:                { legacy: "com.palm.db",         modern: "com.palm.db" },
        filecache:         { legacy: "com.palm.filecache",  modern: "com.palm.filecache" },
        appmanager:        { legacy: "com.palm.applicationManager",
                             modern: "com.palm.applicationManager" },
        keymanager:        { legacy: "com.palm.keymanager", modern: "com.palm.keymanager" }
    };

    /**
     * The bus name for a logical service on this device, or null if it has none.
     */
    that.service = function (logical) {
        var entry = SERVICES[logical];
        if (!entry) {
            throw new Error("Unknown platform service: " + logical);
        }
        return isModernBus ? entry.modern : entry.legacy;
    };

    /**
     * The same, as a palm:// URL. Returns null when the service does not exist,
     * so callers can skip rather than build "palm://null".
     */
    that.url = function (logical) {
        var name = that.service(logical);
        return name === null ? null : "palm://" + name;
    };

    /** For the startup log: which set of names this device resolved to. */
    that.describe = function () {
        return isModernBus ? "OSE bus (com.webos.service.* names)"
                           : "legacy webOS bus (com.palm.* names)";
    };

    return that;
}());
