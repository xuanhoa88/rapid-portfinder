const net = require("net");
const os = require("os");

/**
 * Port Manager - A comprehensive Node.js port management library
 *
 * @example Basic Usage
 * ```javascript
 *
 * // Get any available port
 * const port = await getOpenPort();
 * console.log(`Server will run on port ${port}`);
 *
 * // Get specific port or throw if unavailable/locked
 * try {
 *   const specificPort = await getOpenPort({ port: 3000 });
 *   console.log(`Got port 3000: ${specificPort}`);
 * } catch (error) {
 *   console.log(`Port 3000 not available: ${error.message}`);
 * }
 * ```
 *
 * @example Advanced Configuration
 * ```javascript
 *
 * // Configure global settings
 * configurePortManager({
 *   maxLockDuration: 600_000, // 10 minutes
 *   defaultConcurrency: 10,
 *   cleanupInterval: 30_000
 * });
 *
 * // Get port with custom options
 * const port = await getOpenPort({
 *   port: [3000, 3001, 3002], // Try these ports in order
 *   exclude: [3001], // Skip port 3001
 *   includePrivate: true, // Include private network addresses
 *   concurrency: 8, // Use 8 concurrent host checks
 *   timeout: 2000, // 2 second timeout per check
 *   maxErrorsInMessage: 5 // Show up to 5 errors in error messages
 * });
 * ```
 *
 * @example Port Locking & Management
 * ```javascript
 *
 * // Get and automatically lock a port
 * const port = await getOpenPort({ port: 3000 });
 * console.log('Port locked:', isPortLocked(port)); // true
 *
 * // Check what's locked
 * console.log('All locked ports:', getLockedPorts());
 * console.log('Lock statistics:', getPortStats());
 *
 * // Release when done
 * releasePort(port);
 * console.log('Port released:', !isPortLocked(port)); // true
 * ```
 *
 * @example Network Discovery & Debugging
 * ```javascript
 *
 * // Inspect available network interfaces
 * const networkInfo = getNetworkInfo();
 * console.log('Public addresses:', networkInfo.public);
 * console.log('Private addresses:', networkInfo.private);
 * console.log('Host discovery will use:', networkInfo.hostDiscovery.defaultHosts);
 *
 * // Debug IPv6 addresses
 * const ipv6Info = classifyIPv6Address('fe80::1%en0');
 * console.log('Address classification:', {
 *   isPrivate: ipv6Info.isPrivate,
 *   isLinkLocal: ipv6Info.isLinkLocal,
 *   isUniqueLocal: ipv6Info.isUniqueLocal
 * });
 * ```
 *
 * @example Error Handling & Cleanup
 * ```javascript
 *
 * // Handle specific errors
 * try {
 *   const port = await getOpenPort({ port: 80 }); // Privileged port
 * } catch (error) {
 *   if (error instanceof LockedPortError) {
 *     console.log('Port is locked by another process');
 *   } else if (error.code === 'EACCES') {
 *     console.log('Permission denied - need sudo for port 80');
 *   } else if (error.code === 'EADDRINUSE') {
 *     console.log('Port already in use');
 *   }
 * }
 *
 * // Manual cleanup management
 * startCleanupTimer(10_000); // Start cleanup every 10 seconds
 * const cleaned = cleanupExpiredPorts(); // Manual cleanup
 * console.log(`Cleaned up ${cleaned} expired locks`);
 * ```
 */

/**
 * Custom error for locked ports.
 */
class LockedPortError extends Error {
	constructor(port) {
		super(`Port ${port} is locked`);
		this.name = "LockedPortError";
		this.code = "EPORTLOCKED";
	}
}

/**
 * Port Manager configuration and state.
 */
const portManager = {
	locked: new Map(), // port number => timestamp
	cleanupInterval: 15_000,
	maxLockDuration: 300_000, // 5 minutes max lock duration
	minPort: 1024,
	maxPort: 65_535,
	cleanupTimer: null,
	defaultConcurrency: 5, // Default concurrency for host checks
};

/**
 * @typedef {Object} PortOptions
 * @property {number|number[]=} port - Port number(s) to check. Use 0 for "any available port" (OS picks)
 * @property {string=} host - Host address to bind to
 * @property {number[]=} exclude - Ports to exclude from checking
 * @property {number=} timeout - Timeout for port checks in milliseconds (default: 1000)
 * @property {number=} cleanupInterval - Cleanup interval for locked ports (default: 15000)
 * @property {number=} concurrency - Maximum concurrent host checks (default: 5)
 * @property {boolean=} includePrivate - Include private/link-local addresses in host discovery (default: false). NOTE: By default, only public addresses are used for host discovery. Set to true to include all local addresses.
 * @property {number=} maxErrorsInMessage - Maximum number of errors to include in error messages (default: 3)
 */

/**
 * Check if the input is iterable.
 * @param {any} ports - The object to test.
 * @returns {boolean} True if the source is iterable, False otherwise.
 */
const isIterable = (ports) =>
	ports != null && typeof ports[Symbol.iterator] === "function";

/**
 * Creates a list of ports to check, adding fallback port 0.
 * @param {number|number[]|null|undefined} ports - Ports to check.
 * @returns {number[]} List of ports to check.
 */
const createPorts = (ports) => {
	if (ports === null || ports === undefined) return [0];
	return isIterable(ports) ? [...new Set(ports)] : [ports];
};

/**
 * Clean up expired locked ports.
 *
 * @returns {number} Number of ports that were cleaned up.
 */
const cleanupExpiredPorts = () => {
	const initialSize = portManager.locked.size;
	const now = Date.now();
	for (const [port, timestamp] of portManager.locked) {
		if (now - timestamp >= portManager.maxLockDuration) {
			portManager.locked.delete(port);
		}
	}
	return initialSize - portManager.locked.size;
};

/**
 * Check if an IP address is private/link-local with comprehensive IPv6 support.
 * @param {string} address - IP address to check.
 * @returns {boolean} True if address is private/link-local.
 */
const isPrivateAddress = (address) => {
	// Normalize IPv6 address (basic normalization)
	const normalizedAddress = address.toLowerCase().replace(/^::ffff:/, ""); // Remove IPv4-mapped prefix

	// IPv4 private ranges
	if (/^10\./.test(normalizedAddress)) return true; // 10.0.0.0/8
	if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(normalizedAddress)) return true; // 172.16.0.0/12
	if (/^192\.168\./.test(normalizedAddress)) return true; // 192.168.0.0/16
	if (/^169\.254\./.test(normalizedAddress)) return true; // 169.254.0.0/16 (link-local)
	if (/^127\./.test(normalizedAddress)) return true; // 127.0.0.0/8 (loopback)

	// IPv6 private ranges (more comprehensive)
	if (normalizedAddress.startsWith("fe80:")) return true; // Link-local fe80::/10
	if (/^fe[89ab][0-9a-f]:/.test(normalizedAddress)) return true; // Link-local fe80::/10 (full range)
	if (
		normalizedAddress.startsWith("fc00:") ||
		normalizedAddress.startsWith("fd")
	)
		return true; // Unique local fc00::/7
	if (/^f[cd][0-9a-f]{2}:/.test(normalizedAddress)) return true; // Unique local fc00::/7 (full range)
	if (normalizedAddress === "::1") return true; // Loopback
	if (normalizedAddress.startsWith("::1")) return true; // Loopback variations
	if (/^::1$|^::1\//.test(normalizedAddress)) return true; // Loopback with prefix

	// Site-local (deprecated but still used) fec0::/10
	if (normalizedAddress.startsWith("fec0:")) return true;
	if (/^fec[0-9a-f]:/.test(normalizedAddress)) return true;

	// Multicast ranges (typically not used for binding)
	if (normalizedAddress.startsWith("ff")) return true; // IPv6 multicast ff00::/8
	if (/^22[4-9]\.|^23[0-9]\./.test(normalizedAddress)) return true; // IPv4 multicast 224.0.0.0/4

	return false;
};

/**
 * Get all local network interfaces with enhanced documentation.
 * @param {boolean} includePrivate - Whether to include private/link-local addresses.
 * @returns {Set<string>} Host addresses.
 * @description By default, only public addresses are included for host discovery.
 * This means the function will exclude:
 * - IPv4: 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x, 169.254.x.x
 * - IPv6: fe80::/10 (link-local), fc00::/7 (unique local), ::1 (loopback)
 * Set includePrivate=true to include all local network addresses.
 */
const createHosts = (includePrivate = false) => {
	const interfaces = os.networkInterfaces() || {};
	const hosts = new Set(["0.0.0.0"]); // Always include bind-all address

	Object.values(interfaces).forEach((iface) => {
		iface?.forEach((config) => {
			if (!config.internal) {
				if (includePrivate || !isPrivateAddress(config.address)) {
					hosts.add(config.address);
				}
			}
		});
	});

	return hosts;
};

/**
 * Check port availability.
 * @param {Object} options - Port check options.
 * @param {number} options.port - Port to check.
 * @param {string=} options.host - Host to bind to.
 * @param {number=} options.timeout - Timeout in milliseconds.
 * @returns {Promise<number>} Verified port number.
 */
const checkPortAvailability = (options) => {
	const server = net.createServer();
	if (server && typeof server.unref === "function") {
		server.unref();
	}

	return new Promise((resolve, reject) => {
		const timeoutMs = options.timeout || 1000;
		const timeout = setTimeout(() => {
			if (server && typeof server.close === "function") {
				server.close(() =>
					reject(new Error(`Port check timed out after ${timeoutMs}ms`)),
				);
			} else {
				reject(new Error(`Port check timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);

		if (server && typeof server.once === "function") {
			server.once("error", (err) => {
				clearTimeout(timeout);
				if (server && typeof server.close === "function") {
					server.close(() => reject(err));
				} else {
					reject(err);
				}
			});
		}

		if (server && typeof server.listen === "function") {
			server.listen(options, () => {
				clearTimeout(timeout);
				const address =
					server.address && typeof server.address === "function"
						? server.address()
						: null;
				if (address && typeof address === "object" && address.port > 0) {
					if (server && typeof server.close === "function") {
						server.close(() => resolve(address.port));
					} else {
						resolve(address.port);
					}
				} else {
					if (server && typeof server.close === "function") {
						server.close(() => reject(new Error("Invalid port address")));
					} else {
						reject(new Error("Invalid port address"));
					}
				}
			});
		}
	});
};

/**
 * Process array in chunks with concurrency limit.
 * @param {Array} array - Array to process.
 * @param {Function} processor - Async function to process each item.
 * @param {number} concurrency - Maximum concurrent operations.
 * @returns {Promise<Array>} Array of results.
 */
const processWithLimit = async (array, processor, concurrency = 5) => {
	const results = [];
	const errors = [];

	for (let i = 0; i < array.length; i += concurrency) {
		const chunk = array.slice(i, i + concurrency);
		try {
			const chunkResults = await Promise.all(chunk.map(processor));
			results.push(...chunkResults);
		} catch (error) {
			errors.push(error);
			// Continue processing other chunks even if one fails
		}
	}

	// If we have some results, return them; otherwise throw the first error
	if (results.length > 0) {
		return results;
	}

	if (errors.length > 0) {
		throw errors[0];
	}

	return results;
};

/**
 * Verify port availability across hosts.
 * @param {Object} options - Port options.
 * @param {Set<string>} hosts - Network hosts.
 * @param {number} concurrency - Concurrency limit for host checks.
 * @returns {Promise<number>} Verified port number.
 */
const verifyPort = async (options, hosts, concurrency = 5) => {
	if (options.host || options.port === 0) {
		return checkPortAvailability(options);
	}

	const hostsArray = Array.from(hosts);
	const results = await processWithLimit(
		hostsArray,
		(host) => checkPortAvailability({ ...options, host }),
		concurrency,
	);

	const validPort = results.find(
		(port) => typeof port === "number" && !isNaN(port) && port > 0,
	);

	if (!validPort) {
		throw new Error(
			`Port ${
				options.port
			} is not available on any of the network interfaces: ${hostsArray.join(
				", ",
			)}`,
		);
	}

	return validPort;
};

/**
 * Validate port number.
 * @param {any} port - Port to validate.
 * @throws {TypeError} If port is not a valid integer.
 * @throws {RangeError} If port is outside valid range.
 */
const validatePort = (port) => {
	if (port !== undefined && port !== 0) {
		if (!Number.isInteger(port)) {
			throw new TypeError("Port must be an integer");
		}
		if (port < portManager.minPort || port > portManager.maxPort) {
			throw new RangeError(
				`Port must be between ${portManager.minPort} and ${portManager.maxPort}`,
			);
		}
	}
};

/**
 * Format error messages with truncation for readability.
 * @param {Array} errors - Array of {port, error} objects.
 * @param {number} maxErrors - Maximum errors to include in message.
 * @returns {string} Formatted error message.
 */
const formatErrorMessage = (errors, maxErrors = 3) => {
	if (errors.length === 0) {
		return "All ports excluded or unavailable";
	}

	const errorMessages = errors
		.slice(0, maxErrors)
		.map(({ port, error }) => `Port ${port}: ${error.message}`);

	if (errors.length > maxErrors) {
		const remaining = errors.length - maxErrors;
		errorMessages.push(
			`... and ${remaining} more error${remaining > 1 ? "s" : ""}`,
		);
	}

	return errorMessages.join("; ");
};

/**
 * Get an available port.
 * @param {PortOptions} options - Configuration options.
 * @returns {Promise<number>} Available port number.
 * @throws {LockedPortError} If requested port is locked.
 * @throws {Error} If no available ports found.
 */
const getOpenPort = async (options = {}) => {
	// Validate input
	if (options.port !== undefined) {
		if (Array.isArray(options.port)) {
			options.port.forEach(validatePort);
		} else {
			validatePort(options.port);
		}
	}

	const exclude = new Set(isIterable(options.exclude) ? options.exclude : []);
	const concurrency = options.concurrency || portManager.defaultConcurrency;

	// Allow custom cleanup interval via options
	const cleanupInterval =
		options.cleanupInterval || portManager.cleanupInterval;

	// Start cleanup timer if not already running
	if (!portManager.cleanupTimer) {
		portManager.cleanupTimer = setInterval(
			cleanupExpiredPorts,
			cleanupInterval,
		);
		if (portManager.cleanupTimer.unref) {
			portManager.cleanupTimer.unref();
		}
	}

	const hosts = createHosts(options.includePrivate);
	const maxErrors = options.maxErrorsInMessage || 3;

	const portsToCheck = createPorts(
		options.port !== undefined
			? Array.isArray(options.port)
				? options.port
				: [options.port]
			: undefined,
	);

	const errors = [];

	for (const port of portsToCheck) {
		try {
			// Skip excluded ports
			if (exclude.has(port)) {
				continue;
			}

			// Check if port is locked
			if (portManager.locked.has(port)) {
				if (port !== 0) {
					throw new LockedPortError(port);
				}
				continue;
			}

			let availablePort = await verifyPort(
				{ ...options, port },
				hosts,
				concurrency,
			);

			// If the returned port is locked, try port 0 (if original was 0) or throw error
			while (portManager.locked.has(availablePort)) {
				if (port !== 0) {
					throw new LockedPortError(availablePort);
				}
				availablePort = await verifyPort(
					{ ...options, port: 0 },
					hosts,
					concurrency,
				);
			}

			// Lock the port if it's not port 0 (port 0 means "any available port" - OS picks)
			if (availablePort !== 0) {
				portManager.locked.set(availablePort, Date.now());
			}

			return availablePort;
		} catch (error) {
			errors.push({ port, error });

			// Re-throw specific errors immediately for single port requests
			if (error instanceof LockedPortError && portsToCheck.length === 1) {
				throw error;
			}

			// Handle port in use errors
			if (error.code === "EADDRINUSE") {
				if (port !== 0) {
					// If specific port requested and in use, continue to next port
					continue;
				}
				throw error;
			}

			// Handle permission errors (ports < 1024 typically require root)
			if (error.code === "EACCES") {
				continue;
			}

			// For other errors, continue trying other ports if available
			if (portsToCheck.length > 1) {
				continue;
			}

			// Re-throw if this was the last/only port
			throw error;
		}
	}

	// Check if any requested ports were locked
	const lockedPorts = portsToCheck.filter((port) =>
		portManager.locked.has(port),
	);
	if (lockedPorts.length > 0) {
		throw new LockedPortError(lockedPorts[0]);
	}

	// Create detailed error with truncated error list for readability
	const errorMessage = formatErrorMessage(errors, maxErrors);
	throw new Error(`No available ports found. Errors: ${errorMessage}`);
};

/**
 * Create array of sequential port numbers.
 * @param {number} from - Starting port.
 * @param {number} to - Ending port.
 * @returns {number[]} List of port numbers.
 * @throws {TypeError} If from or to are not integers.
 * @throws {RangeError} If ports are outside valid range or from > to.
 */
const getPortRange = (from, to) => {
	if (!Number.isInteger(from) || !Number.isInteger(to)) {
		throw new TypeError("`from` and `to` must be integer numbers");
	}

	if (from < portManager.minPort || from > portManager.maxPort) {
		throw new RangeError(
			`\`from\` must be between ${portManager.minPort} and ${portManager.maxPort}`,
		);
	}

	if (to < portManager.minPort || to > portManager.maxPort) {
		throw new RangeError(
			`\`to\` must be between ${portManager.minPort} and ${portManager.maxPort}`,
		);
	}

	if (from > to) {
		throw new RangeError("`to` must be greater than or equal to `from`");
	}

	return Array.from({ length: to - from + 1 }, (_, i) => from + i);
};

/**
 * Clear all locked ports and stop cleanup timer.
 */
const clearLockedPorts = () => {
	portManager.locked.clear();
	if (portManager.cleanupTimer) {
		clearInterval(portManager.cleanupTimer);
		portManager.cleanupTimer = null;
	}
};

/**
 * Release a specific locked port.
 * @param {number} port - Port number to release.
 * @returns {boolean} True if port was locked and released, false if not locked.
 */
const releasePort = (port) => {
	return portManager.locked.delete(port);
};

/**
 * Get all currently locked ports.
 * @returns {number[]} Array of locked port numbers.
 */
const getLockedPorts = () => Array.from(portManager.locked.keys());

/**
 * Check if a port is currently locked.
 * @param {number} port - Port number to check.
 * @returns {boolean} True if port is locked, false otherwise.
 */
const isPortLocked = (port) => portManager.locked.has(port);

/**
 * Get the timestamp when a port was locked.
 * @param {number} port - Port number.
 * @returns {number|null} Timestamp when port was locked, or null if not locked.
 */
const getPortLockTime = (port) => portManager.locked.get(port) || null;

/**
 * Start the cleanup timer manually (useful for applications that only query locks).
 * @param {number=} interval - Cleanup interval in milliseconds.
 */
const startCleanupTimer = (interval) => {
	if (portManager.cleanupTimer) {
		clearInterval(portManager.cleanupTimer);
	}

	const cleanupInterval = interval || portManager.cleanupInterval;
	portManager.cleanupTimer = setInterval(cleanupExpiredPorts, cleanupInterval);

	if (portManager.cleanupTimer.unref) {
		portManager.cleanupTimer.unref();
	}
};

/**
 * Stop the cleanup timer.
 */
const stopCleanupTimer = () => {
	if (portManager.cleanupTimer) {
		clearInterval(portManager.cleanupTimer);
		portManager.cleanupTimer = null;
	}
};

/**
 * Get detailed statistics about locked ports.
 * @returns {Object} Statistics including count, oldest lock, etc.
 */
const getPortStats = () => {
	const now = Date.now();
	const locks = Array.from(portManager.locked.entries());

	if (locks.length === 0) {
		return {
			totalLocked: 0,
			longestHeldLock: null,
			averageLockAge: 0,
			expiredCount: 0,
		};
	}

	const ages = locks.map(([_, timestamp]) => now - timestamp);
	const expired = locks.filter(
		([_, timestamp]) => now - timestamp >= portManager.maxLockDuration,
	);

	return {
		totalLocked: locks.length,
		longestHeldLock: {
			port: locks.reduce(
				(oldest, [port, timestamp]) =>
					!oldest || timestamp < oldest.timestamp
						? { port, timestamp }
						: oldest,
				null,
			),
			age: Math.max(...ages),
		},
		averageLockAge: ages.reduce((sum, age) => sum + age, 0) / ages.length,
		expiredCount: expired.length,
		ports: locks.map(([port, timestamp]) => ({
			port,
			timestamp,
			age: now - timestamp,
			expired: now - timestamp >= portManager.maxLockDuration,
		})),
	};
};

/**
 * Configure the port manager settings.
 * @param {Object} config - Configuration object.
 */
const configurePortManager = (config = {}) => {
	if (typeof config.cleanupInterval === "number")
		portManager.cleanupInterval = config.cleanupInterval;
	if (typeof config.maxLockDuration === "number")
		portManager.maxLockDuration = config.maxLockDuration;
	if (typeof config.defaultConcurrency === "number")
		portManager.defaultConcurrency = config.defaultConcurrency;
	if (typeof config.minPort === "number") portManager.minPort = config.minPort;
	if (typeof config.maxPort === "number") portManager.maxPort = config.maxPort;
	// Restart timer if cleanupInterval changes
	if (typeof config.cleanupInterval === "number") {
		if (portManager.cleanupTimer) {
			clearInterval(portManager.cleanupTimer);
			portManager.cleanupTimer = setInterval(
				cleanupExpiredPorts,
				portManager.cleanupInterval,
			);
			if (portManager.cleanupTimer.unref) portManager.cleanupTimer.unref();
		}
	}
};

/**
 * Get network information (public, private, internal addresses).
 * @param {boolean} [includePrivate=false] - Whether to include private addresses.
 * @returns {Object} Network info.
 */
const getNetworkInfo = (includePrivate = false) => {
	const interfaces = os.networkInterfaces() || {};
	const publicAddrs = [];
	const privateAddrs = [];
	const internalAddrs = [];
	for (const [iface, configs] of Object.entries(interfaces)) {
		if (!configs) continue;
		for (const config of configs) {
			if (config.internal) {
				internalAddrs.push({ interface: iface, ...config });
			} else if (isPrivateAddress(config.address)) {
				privateAddrs.push({ interface: iface, ...config });
			} else {
				publicAddrs.push({ interface: iface, ...config });
			}
		}
	}
	return {
		public: publicAddrs,
		private: privateAddrs,
		internal: internalAddrs,
		total: publicAddrs.length + privateAddrs.length + internalAddrs.length,
		hostDiscovery: {
			defaultHosts: Array.from(createHosts(includePrivate)),
			explanation: includePrivate
				? "Host discovery includes all non-internal (public and private) addresses."
				: "Host discovery includes only public addresses.",
		},
	};
};

/**
 * Classify an IPv6 address.
 * @param {string} address - IPv6 address.
 * @returns {Object} Classification result.
 */
const classifyIPv6Address = (address) => {
	const result = {};
	const addr = address.toLowerCase();
	if (addr === "::1") result.isLoopback = true;
	if (addr.startsWith("fe80:") || /^fe[89ab][0-9a-f]:/.test(addr))
		result.isLinkLocal = true;
	if (addr.startsWith("fc00:") || addr.startsWith("fd"))
		result.isUniqueLocal = true;
	if (/^f[cd][0-9a-f]{2}:/.test(addr)) result.isUniqueLocal = true;
	if (addr.startsWith("ff")) result.isMulticast = true;
	if (/^::ffff:/.test(addr)) result.isIPv4Mapped = true;
	// Private if any of the above
	if (
		result.isLoopback ||
		result.isLinkLocal ||
		result.isUniqueLocal ||
		result.isMulticast ||
		result.isIPv4Mapped
	) {
		result.isPrivate = true;
	} else {
		result.isPrivate = false;
	}
	return result;
};

// Graceful cleanup on process exit
let cleanupHandlersRegistered = false;

const exitHandler = () => {
	console.log("Received exit, cleaning up...");
	clearLockedPorts();
};

const sigintHandler = () => {
	console.log("Received SIGINT, cleaning up...");
	clearLockedPorts();
	process.exit(0);
};

const sigtermHandler = () => {
	console.log("Received SIGTERM, cleaning up...");
	clearLockedPorts();
	process.exit(0);
};

const cleanupHandlerFns = [
	["exit", exitHandler],
	["SIGINT", sigintHandler],
	["SIGTERM", sigtermHandler],
];

function registerProcessCleanupHandlers() {
	if (
		cleanupHandlersRegistered ||
		typeof process === "undefined" ||
		!process.on
	)
		return;
	for (const [event, fn] of cleanupHandlerFns) {
		process.on(event, fn);
	}
	cleanupHandlersRegistered = true;
}

function unregisterProcessCleanupHandlers() {
	if (
		!cleanupHandlersRegistered ||
		typeof process === "undefined" ||
		!process.removeListener
	)
		return;
	for (const [event, fn] of cleanupHandlerFns) {
		process.removeListener(event, fn);
	}
	cleanupHandlersRegistered = false;
}

module.exports = {
	LockedPortError,
	portManager,
	cleanupExpiredPorts,
	getOpenPort,
	getPortRange,
	clearLockedPorts,
	releasePort,
	getLockedPorts,
	isPortLocked,
	getPortLockTime,
	startCleanupTimer,
	stopCleanupTimer,
	getPortStats,
	configurePortManager,
	getNetworkInfo,
	classifyIPv6Address,
	registerProcessCleanupHandlers,
	unregisterProcessCleanupHandlers,
};
