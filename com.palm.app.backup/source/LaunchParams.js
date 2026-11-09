/* What the app was launched (or relaunched) to do.
 *
 * LuneOS's first use cannot restore a backup while it runs, so it asks
 * LunaAppManager to launch this app with {"restore": true} once setup is over
 * (luna-appmanager Src/base/FirstUseHandoff.cpp). That opens the restore flow
 * - the same one as "Restore a backup..." in the app menu - and nothing more:
 * the user still picks the backup and confirms it.
 *
 * Only a JSON true counts. Launch parameters come from whoever launched the
 * app, and on webOS they may arrive as the object or as its JSON text.
 */

function launchWantsRestore(params) {
    if (typeof params === "string") {
        try {
            params = JSON.parse(params);
        } catch (e) {
            return false;
        }
    }
    return !!params && typeof params === "object" && params.restore === true;
}
