// Some Windows hosts intermittently fail uv_os_get_passwd before tsx can start.
// Preserve the native implementation when healthy and provide only the fields
// Node documents when that OS lookup is unavailable.
const os = require("node:os");

try {
  os.userInfo();
} catch {
  os.userInfo = () => ({
    username: process.env.USERNAME || "faultline",
    uid: -1,
    gid: -1,
    shell: null,
    homedir: process.env.USERPROFILE || process.cwd(),
  });
}
