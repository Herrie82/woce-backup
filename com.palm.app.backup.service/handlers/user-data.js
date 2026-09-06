/* User file category selection.
 *
 * Categories are surfaced with a live file count and byte total so the user can
 * see what enabling one costs before they do it — a local backup is written to
 * the same volume the media lives on.
 */
/*global credentials, logger, prefs, userData */

function GetUserDataCategoriesAssistant() {
    this.run = function (future) {
        var estimate = userData.getEstimate();
        var categories;

        estimate.then(this, function (f) {
            categories = f.result.categories;
            f.nest(prefs.getUserData());
        });
        estimate.then(this, function (f) {
            var stored = f.result;

            // Saved passwords ride in the same selection list but are not a
            // media category: there is no directory to walk and no size to
            // report, so it carries a `detail` string the UI shows instead of
            // the "{count} files - {size}" line, and `always` so it is offered
            // even though its count is zero.
            categories.push({
                id:      credentials.CATEGORY_ID,
                label:   credentials.CATEGORY_LABEL,
                enabled: stored[credentials.CATEGORY_ID] === true,
                count:   0,
                bytes:   0,
                always:  true,
                detail:  "Encrypted with a passphrase you choose"
            });

            f.result = { returnValue: true, categories: categories };
        });
        future.nest(estimate);
    };
}

function SetUserDataCategoriesAssistant() {
    this.run = function (future) {
        var args = this.controller.args;
        var categories = args.categories;
        if (!categories) {
            throw new Error("categories is required");
        }

        var chain = prefs.getUserData();
        chain.then(this, function (f) {
            var current = f.result;
            var updated = {};
            var id;

            // Start from the stored selection so a caller can send a partial
            // update without silently clearing the categories it omitted.
            for (id in current) {
                if (current.hasOwnProperty(id)) {
                    updated[id] = current[id];
                }
            }
            for (id in categories) {
                if (categories.hasOwnProperty(id)) {
                    if (!prefs.DEFAULT_USER_DATA.hasOwnProperty(id)) {
                        throw new Error("Unknown user data category: " + id);
                    }
                    updated[id] = categories[id] === true;
                }
            }

            logger.log("User data categories set to", updated);
            f.nest(prefs.setUserData(updated));
        });
        chain.then(this, function (f) {
            var result = f.result;
            f.result = {
                returnValue: true,
                categories: (result && result.userData) || {}
            };
        });
        future.nest(chain);
    };
}
