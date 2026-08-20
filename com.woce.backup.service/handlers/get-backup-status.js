/*global backup, logger, privileged */

function GetBackupStatusAssistant() {

    /**
     * Current status, plus a stream of updates when subscribe is true.
     *
     * The status shape is the stock one — { STATUS, percent, type } — because
     * the ported UI switches on exactly those values.
     *
     * `privileged` is ours: it tells the UI whether the root helper is present,
     * so it can say which files a backup will have to skip.
     */
    this.run = function (future, subscription) {
        if (subscription !== undefined) {
            backup.addStatusListener(function (status) {
                subscription.get().result = status;
            });
        }

        var current = backup.getStatus();
        var pf = privileged.isAvailable();
        pf.then(this, function (f) {
            var isPrivileged = f.exception ? false : f.result;
            var ret = { returnValue: true, privileged: isPrivileged === true };
            if (current) {
                for (var key in current) {
                    if (current.hasOwnProperty(key)) {
                        ret[key] = current[key];
                    }
                }
            }
            f.result = ret;
        });
        future.nest(pf);
    };
}
