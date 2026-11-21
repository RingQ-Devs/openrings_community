// Usage (run from the community folder):
//   node scripts/init.js                                         -> create tables, default forums and starter personas
//   node scripts/init.js --admin <username> <email> <password>   -> create an admin (or promote an existing user)
//   node scripts/init.js --support <username> <email> <password> -> create a RingQ Support staff account
//   node scripts/init.js --reset-password <username> <new-password>
import { bootstrap } from '../src/bootstrap.js';
import { createUser, getUserByUsername, validateRegistration, setRole, setPassword, deleteAllSessions } from '../src/services/users.js';
import { val, closeDb } from '../src/db.js';

// Command Prompt (cmd.exe) does not remove single quotes, so 'secret' arrives with the quotes.
function cleanPassword(value) {
  if (typeof value === 'string' && value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    console.log("Note: removed the ' ' around the password. In Command Prompt use double quotes, e.g. \"My-Pass-2026\".");
    return value.slice(1, -1);
  }
  return value;
}

async function main() {
  await bootstrap();
  const args = process.argv.slice(2);

  for (const flag of ['--admin', '--support']) {
    const i = args.indexOf(flag);
    if (i === -1) continue;
    const [username, email, rawPassword] = args.slice(i + 1, i + 4);
    const password = cleanPassword(rawPassword);
    const role = flag === '--admin' ? 'admin' : 'support';
    const existing = username && (await getUserByUsername(username));
    if (existing) {
      await setRole(existing.id, role);
      console.log(`Set role of existing user "${username}" to ${role}.`);
      continue;
    }
    const errors = await validateRegistration({ username, email, password });
    if (errors.length) throw new Error(errors.join('\n'));
    await createUser({ username, email, password, role, title: role === 'admin' ? 'Community Admin' : 'RingQ Support' });
    console.log(`Created ${role} account "${username}".`);
  }

  const ri = args.indexOf('--reset-password');
  if (ri !== -1) {
    const [username, rawPassword] = args.slice(ri + 1, ri + 3);
    const password = cleanPassword(rawPassword);
    const user = username && (await getUserByUsername(username));
    if (!user) throw new Error(`No user named "${username}".`);
    if (!password || password.length < 8) throw new Error('New password must be at least 8 characters.');
    await setPassword(user.id, password);
    await deleteAllSessions(user.id);
    console.log(`Password reset for "${username}".`);
  }

  console.log(
    `Database ready: ${await val('SELECT COUNT(*) FROM forums')} forums, ` +
      `${await val("SELECT COUNT(*) FROM users WHERE role = 'persona'")} personas, ` +
      `${await val("SELECT COUNT(*) FROM users WHERE role = 'admin'")} admin(s).`,
  );
}

main()
  .catch((err) => {
    console.error('Error: ' + err.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
