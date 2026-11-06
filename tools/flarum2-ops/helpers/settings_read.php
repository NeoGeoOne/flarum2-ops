<?php
/**
 * flarum2-ops read-only settings reader.
 *
 * Flarum 2 has no GET endpoint for settings (GET /api/settings = 405) and
 * several design keys (custom_less, theme_colored_header, extension settings)
 * are not exposed on GET /api. This helper reads them straight from the
 * forum's `settings` table with a read-only PDO connection built from the
 * forum's own config.php.
 *
 * Guarantees:
 *  - SELECT only; MySQL/MariaDB sessions are switched to READ ONLY.
 *  - Never prints config.php, the DSN, the DB user or the password.
 *  - Secret-looking keys are never output with their value (state "redacted").
 *
 * Usage: php settings_read.php <forum_root>   (JSON request on stdin)
 *   {"mode":"get","keys":["custom_less"],"prefixes":["flarum-tags."]}
 *   {"mode":"keys"}                    -> all key names (+ redaction flag)
 *   {"mode":"permissions","names":["viewForum"]}
 * Output: JSON on stdout. Exit 0 on success, 1 on error ({"error": "..."}).
 */

declare(strict_types=1);

function out(array $data, int $code = 0): void
{
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
    exit($code);
}

function is_secret_key(string $key): bool
{
    // Mail transport credentials and anything that looks like a credential.
    if (preg_match('/^mail_/', $key) && !in_array($key, ['mail_driver', 'mail_format', 'mail_from'], true)) {
        return true;
    }
    return (bool) preg_match('/(pass(word)?|secret|token|api_?key|private|credential|(^|[._-])key$)/i', $key);
}

$root = $argv[1] ?? '';
if ($root === '' || !is_file($root . '/config.php')) {
    out(['error' => 'forum root not found or has no config.php'], 1);
}

$raw = stream_get_contents(STDIN);
$req = $raw !== '' && $raw !== false ? json_decode($raw, true) : [];
if (!is_array($req)) {
    out(['error' => 'stdin must be a JSON object'], 1);
}
$mode = $req['mode'] ?? 'get';

$config = (static function (string $file) {
    return include $file;
})($root . '/config.php');
$db = is_array($config) ? ($config['database'] ?? null) : null;
if (!is_array($db)) {
    out(['error' => 'config.php has no database block'], 1);
}
$driver = $db['driver'] ?? 'mysql';
$prefix = (string) ($db['prefix'] ?? '');
if (!preg_match('/^[A-Za-z0-9_]*$/', $prefix)) {
    out(['error' => 'unsupported table prefix'], 1);
}

try {
    switch ($driver) {
        case 'mysql':
        case 'mariadb':
            $dsn = isset($db['unix_socket']) && $db['unix_socket'] !== ''
                ? sprintf('mysql:unix_socket=%s;dbname=%s', $db['unix_socket'], $db['database'])
                : sprintf('mysql:host=%s;port=%s;dbname=%s', $db['host'] ?? 'localhost', $db['port'] ?? 3306, $db['database']);
            $dsn .= ';charset=' . ($db['charset'] ?? 'utf8mb4');
            break;
        case 'pgsql':
            $dsn = sprintf('pgsql:host=%s;port=%s;dbname=%s', $db['host'] ?? 'localhost', $db['port'] ?? 5432, $db['database']);
            break;
        case 'sqlite':
            $dsn = 'sqlite:' . $db['database'];
            break;
        default:
            out(['error' => "unsupported database driver: $driver"], 1);
    }
    $pdo = new PDO($dsn, $db['username'] ?? null, $db['password'] ?? null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    if ($driver === 'mysql' || $driver === 'mariadb') {
        $pdo->exec('SET SESSION TRANSACTION READ ONLY');
    }
} catch (Throwable $e) {
    // PDO messages never contain the password; strip DSN-like fragments anyway.
    out(['error' => 'database connection failed: ' . preg_replace('/(host|dbname|unix_socket)=[^;\s]+/', '$1=***', $e->getMessage())], 1);
}

$table = $prefix . 'settings';

try {
    if ($mode === 'keys') {
        $rows = $pdo->query("SELECT `key` FROM `$table` ORDER BY `key`")->fetchAll();
        $keys = [];
        foreach ($rows as $r) {
            $keys[] = ['key' => $r['key'], 'secret' => is_secret_key($r['key'])];
        }
        out(['keys' => $keys]);
    }

    if ($mode === 'permissions') {
        $names = array_values(array_filter((array) ($req['names'] ?? []), 'is_string'));
        $sql = "SELECT `permission`, `group_id` FROM `{$prefix}group_permission`";
        $params = [];
        if ($names) {
            $sql .= ' WHERE `permission` IN (' . implode(',', array_fill(0, count($names), '?')) . ')';
            $params = $names;
        }
        $stmt = $pdo->prepare($sql . ' ORDER BY `permission`, `group_id`');
        $stmt->execute($params);
        $perms = [];
        foreach ($stmt->fetchAll() as $r) {
            $perms[$r['permission']][] = (int) $r['group_id'];
        }
        out(['permissions' => $perms]);
    }

    if ($mode !== 'get') {
        out(['error' => "unknown mode: $mode"], 1);
    }

    $keys = array_values(array_filter((array) ($req['keys'] ?? []), 'is_string'));
    $prefixes = array_values(array_filter((array) ($req['prefixes'] ?? []), 'is_string'));
    $found = [];

    if ($keys) {
        $stmt = $pdo->prepare("SELECT `key`, `value` FROM `$table` WHERE `key` IN (" . implode(',', array_fill(0, count($keys), '?')) . ')');
        $stmt->execute($keys);
        foreach ($stmt->fetchAll() as $r) {
            $found[$r['key']] = $r['value'];
        }
    }
    foreach ($prefixes as $p) {
        $stmt = $pdo->prepare("SELECT `key`, `value` FROM `$table` WHERE `key` LIKE ? ESCAPE '!'");
        $stmt->execute([str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $p) . '%']);
        foreach ($stmt->fetchAll() as $r) {
            $found[$r['key']] = $r['value'];
        }
    }

    $result = [];
    foreach (array_unique(array_merge($keys, array_keys($found))) as $k) {
        if (is_secret_key($k)) {
            $result[$k] = ['state' => array_key_exists($k, $found) ? 'redacted' : 'absent'];
        } elseif (!array_key_exists($k, $found)) {
            $result[$k] = ['state' => 'absent'];
        } elseif ($found[$k] === null) {
            $result[$k] = ['state' => 'null'];
        } else {
            $result[$k] = ['state' => 'value', 'value' => $found[$k]];
        }
    }
    ksort($result);
    out(['settings' => $result]);
} catch (Throwable $e) {
    out(['error' => 'query failed: ' . $e->getMessage()], 1);
}
