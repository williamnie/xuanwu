import type { SqlMigration } from "../migrations.ts";

export const removeLegacyNotificationSettingsMigration: SqlMigration = {
  id: "030_remove_legacy_notification_settings",
  sql: "",
  apply(sqlite) {
    const table = sqlite.query("select name from sqlite_schema where type='table' and name='app_preferences'").get();
    if (table) sqlite.run("delete from app_preferences where key='notifications.settings'");
  }
};
