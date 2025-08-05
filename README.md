# Rapid Portfinder

A comprehensive Node.js utility for managing and checking the availability of ports on your machine. It supports port locking, custom port ranges, exclusions, network discovery, and more—ideal for networked applications and server setups.

## Features

- **Port Availability Check**: Find an available port on all or specific network interfaces.
- **Port Locking**: Temporarily lock ports to prevent simultaneous usage.
- **Custom Port Ranges**: Define and iterate over specific port ranges.
- **Exclusions**: Exclude certain ports from being used.
- **Timeout Handling**: Configure timeouts for port checks.
- **Network Discovery**: Inspect public/private/local network addresses.
- **Cleanup Management**: Automatic and manual cleanup of expired port locks.
- **Comprehensive API**: Utilities for port status, statistics, and error handling.

## Installation

```bash
npm install rapid-portfinder
```

## Usage

### Get a Free Port

```javascript
const { getOpenPort } = require("rapid-portfinder");

(async () => {
  try {
    const port = await getOpenPort({
      port: [3000, 4000], // Optional preferred ports
      exclude: [8080],    // Ports to exclude
      timeout: 2000       // Optional timeout (ms)
    });
    console.log(`Available port: ${port}`);
  } catch (error) {
    console.error("Error getting a free port:", error);
  }
})();
```

### Lock and Release Ports

```javascript
const { getOpenPort, releasePort, isPortLocked, getLockedPorts } = require("rapid-portfinder");

(async () => {
  const port = await getOpenPort({ port: 3000 });
  console.log('Port locked:', isPortLocked(port)); // true

  // List all locked ports
  console.log('Locked ports:', getLockedPorts());

  // Release when done
  releasePort(port);
  console.log('Port released:', !isPortLocked(port)); // true
})();
```

### Port Range Utility

```javascript
const { getPortRange } = require("rapid-portfinder");

const range = getPortRange(3000, 3010);
console.log(range); // [3000, 3001, ..., 3010]
```

### Handle Port Lock Errors

```javascript
const { getOpenPort, LockedPortError } = require("rapid-portfinder");

(async () => {
  try {
    const port = await getOpenPort({ port: [3000] });
    console.log(`Available port: ${port}`);
  } catch (error) {
    if (error instanceof LockedPortError) {
      console.error(`Port is locked (code: ${error.code})`);
    } else {
      console.error("An error occurred:", error);
    }
  }
})();
```

### Network Discovery & Debugging

```javascript
const { getNetworkInfo, classifyIPv6Address } = require("rapid-portfinder");

const networkInfo = getNetworkInfo();
console.log('Public addresses:', networkInfo.public);
console.log('Private addresses:', networkInfo.private);

const ipv6Info = classifyIPv6Address('fe80::1%en0');
console.log('IPv6 classification:', ipv6Info);
```

### Manual Cleanup Management

```javascript
const { startCleanupTimer, stopCleanupTimer, cleanupExpiredPorts } = require("rapid-portfinder");

// Start automatic cleanup every 10 seconds
startCleanupTimer(10_000);

// Manually clean up expired locks
const cleaned = cleanupExpiredPorts();
console.log(`Cleaned up ${cleaned} expired locks`);

// Stop automatic cleanup
stopCleanupTimer();
```

## Configuration

You can configure global settings using `configurePortManager`:

```javascript
const { configurePortManager } = require("rapid-portfinder");

configurePortManager({
  minPort: 2000,
  maxPort: 60000,
  cleanupInterval: 10_000, // 10 seconds
  maxLockDuration: 600_000 // 10 minutes
});
```

## API

### `getOpenPort(options)`

Finds an available port.

- `options.port` (number|Array<number>): Preferred ports to check (default: `[0]`).
- `options.exclude` (Iterable<number>): Ports to exclude.
- `options.timeout` (number): Timeout for each port check (default: 1000 ms).
- `options.includePrivate` (boolean): Include private/local addresses in host discovery.
- `options.concurrency` (number): Number of concurrent host checks.
- `options.maxErrorsInMessage` (number): Max errors to show in error messages.

Returns: `Promise<number>` — The first available port.

### `getPortRange(from, to)`

Generates a range of ports.

- `from` (number): Starting port.
- `to` (number): Ending port.

Returns: `Array<number>`

### `clearLockedPorts()`

Clears all locked ports and stops the cleanup timer.

### `releasePort(port)`

Releases a specific locked port.

### `getLockedPorts()`

Returns an array of currently locked ports.

### `isPortLocked(port)`

Checks if a port is currently locked.

### `getPortLockTime(port)`

Returns the timestamp when a port was locked, or `null` if not locked.

### `getPortStats()`

Returns statistics about locked ports (count, oldest lock, average age, etc).

### `configurePortManager(config)`

Configures global settings (min/max port, cleanup interval, etc).

### `getNetworkInfo(includePrivate)`

Returns public, private, and internal network addresses.

### `classifyIPv6Address(address)`

Classifies an IPv6 address (loopback, link-local, unique local, etc).

### `startCleanupTimer(interval)`

Starts the automatic cleanup timer.

### `stopCleanupTimer()`

Stops the automatic cleanup timer.

### `LockedPortError`

Custom error thrown for locked ports. Has `.code` property (`EPORTLOCKED`).

## License

Licensed under [MIT](LICENSE) © 2024 xuanguyen


