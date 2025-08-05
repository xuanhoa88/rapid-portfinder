const net = require("net");
const {
	getOpenPort,
	getPortRange,
	clearLockedPorts,
	LockedPortError,
	portManager,
	getPortStats,
	getNetworkInfo,
	classifyIPv6Address,
	cleanupExpiredPorts,
	registerProcessCleanupHandlers,
	unregisterProcessCleanupHandlers,
	startCleanupTimer,
	stopCleanupTimer,
	configurePortManager,
} = require("../src");

// Mocking necessary modules for testing
jest.mock("net");
jest.mock("os", () => ({
	networkInterfaces: jest.fn(() => ({
		eth0: [{ address: "192.168.1.1", internal: false }],
	})),
}));

describe("Port Manager", () => {
	let mockServer;

	beforeEach(() => {
		// Reset mock server for each test
		mockServer = {
			listen: jest.fn((options, callback) => {
				setImmediate(() => callback?.());
				return mockServer;
			}),
			close: jest.fn((callback) => {
				setImmediate(() => callback?.());
				return mockServer;
			}),
			unref: jest.fn(),
			once: jest.fn(),
			address: jest.fn(() => ({ port: 12345 })),
		};

		net.createServer.mockImplementation(() => mockServer);
		unregisterProcessCleanupHandlers();
	});

	afterEach(() => {
		clearLockedPorts();
		jest.clearAllMocks();
	});

	describe("getOpenPort", () => {
		test("should return an available port within valid range", async () => {
			const port = await getOpenPort();
			expect(port).toBeGreaterThanOrEqual(1024);
			expect(port).toBeLessThanOrEqual(65535);
			expect(mockServer.listen).toHaveBeenCalled();
			expect(mockServer.close).toHaveBeenCalled();
		});

		test("should honor specific port request when available", async () => {
			const requestedPort = 12345;
			const port = await getOpenPort({ port: requestedPort });
			expect(port).toBe(requestedPort);
			expect(mockServer.listen).toHaveBeenCalledWith(
				expect.objectContaining({ port: requestedPort }),
				expect.any(Function),
			);
		});

		test("should throw LockedPortError with port number in message if the port is locked", async () => {
			const lockedPort = 8080;
			mockServer.listen.mockImplementation((options, callback) => {
				if (String(options.port) === String(lockedPort)) {
					throw new LockedPortError(`Port ${lockedPort} is locked`);
				}
				callback?.();
				return mockServer;
			});
			portManager.locked.set(lockedPort, Date.now());
			await expect(getOpenPort({ port: lockedPort })).rejects.toThrow(LockedPortError);
			await expect(getOpenPort({ port: lockedPort })).rejects.toThrow(new RegExp(`${lockedPort}`));
			// Also check that listen is not called
			expect(mockServer.listen).not.toHaveBeenCalled();
		});

		test("should throw if all possible ports are locked and include first port in message", async () => {
			const allPorts = [20002, 20003];
			allPorts.forEach(p => portManager.locked.set(p, Date.now()));
			await expect(getOpenPort({ port: allPorts })).rejects.toThrow();
			await expect(getOpenPort({ port: allPorts })).rejects.toThrow(new RegExp(`${allPorts[0]}`));
		});

		test("should respect port exclusion list", async () => {
			const excludedPorts = [8080, 8081];
			const port = await getOpenPort({ exclude: excludedPorts });

			expect(excludedPorts).not.toContain(port);
			expect(mockServer.listen).toHaveBeenCalledWith(
				expect.objectContaining({
					port: expect.not.arrayContaining(excludedPorts),
				}),
				expect.any(Function),
			);
		});

		test("should handle EADDRINUSE error", async () => {
			mockServer.listen.mockImplementation((options, callback) => {
				setImmediate(() => {
					// Simulate the error event
					mockServer.once.mock.calls.find((call) => call[0] === "error")?.[1](
						Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }),
					);
				});
				return mockServer;
			});

			await expect(getOpenPort()).rejects.toThrow("EADDRINUSE");

			// Wait for the next tick to ensure the close method is called
			await new Promise((resolve) => setImmediate(resolve));

			// Verify that close was called after the error
			expect(mockServer.close).toHaveBeenCalled();
		});

		test("should timeout if port check takes too long", async () => {
			const timeout = 100;
			mockServer.listen.mockImplementation(() => {
				// Never call the callback to simulate hanging
				return mockServer;
			});

			await expect(getOpenPort({ timeout })).rejects.toThrow(
				`Port check timed out after ${timeout}ms`,
			);
		});
	});

	describe("Port Locking and Releasing", () => {
		test("should lock a port after acquisition and unlock after release", async () => {
			const port = await getOpenPort({ port: 23456 });
			expect(portManager.locked.has(port)).toBe(true);
			// Release
			const released = portManager.locked.delete(port);
			expect(released).toBe(true);
			expect(portManager.locked.has(port)).toBe(false);
		});

		test("should return false when releasing a non-locked port", () => {
			const released = portManager.locked.delete(99999);
			expect(released).toBe(false);
		});
	});

	describe("Port 0 and Array Port Requests", () => {
		test("should not lock port 0 (OS assigned)", async () => {
			mockServer.address.mockReturnValue({ port: 12345 }); // Simulate OS-assigned port
			const port = await getOpenPort({ port: 0 });
			expect(port).toBe(12345);
			expect(portManager.locked.has(0)).toBe(false);
			expect(portManager.locked.has(port)).toBe(true); // The assigned port should be locked
		});

		test("should return first available port from array, skipping locked/excluded", async () => {
			const lockedPort = 30001;
			const availablePort = 30002;
			portManager.locked.set(lockedPort, Date.now());
			mockServer.address.mockReturnValue({ port: availablePort }); // Always return available port
			const port = await getOpenPort({ port: [lockedPort, availablePort] });
			expect(port).toBe(availablePort);
		});

		test("should throw if all ports in array are locked or excluded", async () => {
			const lockedPort = 40001;
			const excludedPort = 40002;
			portManager.locked.set(lockedPort, Date.now());
			await expect(
				getOpenPort({
					port: [lockedPort, excludedPort],
					exclude: [excludedPort],
				}),
			).rejects.toThrow();
		});
	});

	describe("Concurrency and Multiple Requests", () => {
		test("should return different ports for concurrent requests", async () => {
			let portCounter = 50000;
			mockServer.address.mockImplementation(() => ({ port: portCounter++ }));
			const results = await Promise.all([
				getOpenPort(),
				getOpenPort(),
				getOpenPort(),
			]);
			expect(new Set(results).size).toBe(3);
		});
	});

	describe("getPortRange", () => {
		test("should return correct port range array", () => {
			const range = getPortRange(1024, 1029);
			expect(range).toEqual([1024, 1025, 1026, 1027, 1028, 1029]);
		});

		test.each([
			[1029, 1024, "`to` must be greater than or equal to `from`"],
			[70000, 80000, "`from` must be between 1024 and 65535"],
			["a", 80000, "`from` and `to` must be integer numbers"],
			[1024, "b", "`from` and `to` must be integer numbers"],
			[1024.5, 1025, "`from` and `to` must be integer numbers"],
		])("should validate range inputs (%s, %s)", (from, to, expectedError) => {
			expect(() => getPortRange(from, to)).toThrow(expectedError);
		});
	});

	describe("clearLockedPorts", () => {
		test("should clear all locked ports", () => {
			portManager.locked.set(8080, Date.now());
			portManager.locked.set(8081, Date.now());

			expect(portManager.locked.size).toBe(2);
			clearLockedPorts();
			expect(portManager.locked.size).toBe(0);
		});
	});

	describe("Port Statistics", () => {
		test("should return correct stats for no locked ports", () => {
			const stats = getPortStats();
			expect(stats.totalLocked).toBe(0);
			expect(stats.longestHeldLock).toBeNull();
			expect(stats.averageLockAge).toBe(0);
			expect(stats.expiredCount).toBe(0);
		});

		test("should return correct stats for locked ports", async () => {
			const now = Date.now();
			portManager.locked.set(60000, now - 1000);
			portManager.locked.set(60001, now - 2000);
			const stats = getPortStats();
			expect(stats.totalLocked).toBe(2);
			expect(stats.longestHeldLock.port.port).toBe(60001);
			expect(stats.averageLockAge).toBeGreaterThan(0);
			expect(stats.ports.length).toBe(2);
		});
	});

	describe("Cleanup Expired Ports", () => {
		test("should cleanup expired ports and return count", () => {
			const now = Date.now();
			portManager.maxLockDuration = 1000; // 1 second for test
			portManager.locked.set(61000, now - 2000); // expired
			portManager.locked.set(61001, now - 500); // not expired
			const cleaned = cleanupExpiredPorts();
			expect(cleaned).toBe(1);
			expect(portManager.locked.has(61000)).toBe(false);
			expect(portManager.locked.has(61001)).toBe(true);
		});
	});

	describe("Network Info", () => {
		test("should return network info with mocked interfaces", () => {
			const info = getNetworkInfo();
			expect(info).toHaveProperty("public");
			expect(info).toHaveProperty("private");
			expect(info).toHaveProperty("internal");
			expect(info).toHaveProperty("total");
		});
	});

	describe("IPv6 Classification", () => {
		test("should classify IPv6 loopback address", () => {
			const result = classifyIPv6Address("::1");
			expect(result.isLoopback).toBe(true);
			expect(result.isPrivate).toBe(true);
		});
		test("should classify IPv6 link-local address", () => {
			const result = classifyIPv6Address("fe80::1");
			expect(result.isLinkLocal).toBe(true);
			expect(result.isPrivate).toBe(true);
		});
		test("should classify IPv6 unique local address", () => {
			const result = classifyIPv6Address("fc00::1");
			expect(result.isUniqueLocal).toBe(true);
			expect(result.isPrivate).toBe(true);
		});
		test("should classify IPv6 multicast address", () => {
			const result = classifyIPv6Address("ff02::1");
			expect(result.isMulticast).toBe(true);
			expect(result.isPrivate).toBe(true);
		});
		test("should classify IPv6 public address", () => {
			const result = classifyIPv6Address("2001:db8::1");
			expect(result.isPrivate).toBe(false);
		});
	});

	describe("Edge Cases and Robustness", () => {
		test("should throw or skip if trying to lock an already locked port", async () => {
			const port = 11000;
			portManager.locked.set(port, Date.now());
			await expect(getOpenPort({ port })).rejects.toThrow();
		});
	});

	describe("Configuration", () => {
		test("should respect minPort and maxPort configuration", () => {
			configurePortManager({ minPort: 20000, maxPort: 20010 });
			expect(portManager.minPort).toBe(20000);
			expect(portManager.maxPort).toBe(20010);
		});
		test("should respect maxLockDuration configuration", () => {
			configurePortManager({ maxLockDuration: 12345 });
			expect(portManager.maxLockDuration).toBe(12345);
		});
	});

	describe("Timer and Cleanup Integration", () => {
		test("should trigger cleanup via timer", () => {
			jest.useFakeTimers();
			const now = Date.now();
			portManager.maxLockDuration = 1000;
			portManager.locked.set(12000, now - 2000); // expired
			startCleanupTimer(500);
			jest.advanceTimersByTime(500);
			stopCleanupTimer();
			expect(portManager.locked.has(12000)).toBe(false);
			jest.useRealTimers();
		});
	});

	describe("Process Cleanup Handlers", () => {
		test("should clear locks on exit", () => {
			portManager.locked.set(13000, Date.now());
			const originalExit = process.exit;
			process.exit = jest.fn();
			registerProcessCleanupHandlers();
			process.emit("exit");
			expect(portManager.locked.size).toBe(0);
			process.exit = originalExit;
		});
	});

	describe("Port Statistics Array", () => {
		test("should include correct ports and metadata in stats.ports", () => {
			const now = Date.now();
			portManager.locked.set(14000, now - 100);
			portManager.locked.set(14001, now - 200);
			const stats = getPortStats();
			expect(stats.ports).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ port: 14000, age: expect.any(Number), expired: false }),
					expect.objectContaining({ port: 14001, age: expect.any(Number), expired: false })
				])
			);
		});
	});

	describe("Error Message Details", () => {
		test("should include 'EADDRINUSE' in error message", async () => {
			mockServer.listen.mockImplementation((options, callback) => {
				setImmediate(() => {
					mockServer.once.mock.calls.find((call) => call[0] === "error")?.[1](
						Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" })
					);
				});
				return mockServer;
			});
			await expect(getOpenPort()).rejects.toThrow(/EADDRINUSE/);
		});
		test("should include timeout in error message", async () => {
			const timeout = 123;
			mockServer.listen.mockImplementation(() => mockServer);
			await expect(getOpenPort({ timeout })).rejects.toThrow(
				new RegExp(`timed out after ${timeout}`)
			);
		});
	});

	describe("Process Cleanup Handler Unregistration", () => {
		test("should remove process event handlers", () => {
			registerProcessCleanupHandlers();
			const before = process.listenerCount("exit");
			unregisterProcessCleanupHandlers();
			const after = process.listenerCount("exit");
			expect(after).toBeLessThan(before);
		});
	});

	describe("Network Info with Multiple Interfaces", () => {
		test("should categorize IPv4, IPv6, and internal/external addresses", () => {
			const os = require("os");
			os.networkInterfaces.mockReturnValue({
				eth0: [
					{ address: "192.168.1.100", family: "IPv4", internal: false },
					{ address: "10.0.0.1", family: "IPv4", internal: false },
					{ address: "fe80::1", family: "IPv6", internal: false },
				],
				lo: [
					{ address: "127.0.0.1", family: "IPv4", internal: true },
					{ address: "::1", family: "IPv6", internal: true },
				],
			});
			const info = getNetworkInfo();
			expect(info.private).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ address: "192.168.1.100" }),
					expect.objectContaining({ address: "10.0.0.1" }),
				])
			);
			expect(info.internal).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ address: "127.0.0.1" }),
					expect.objectContaining({ address: "::1" }),
				])
			);
			expect(info.private).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ address: "fe80::1" })
				])
			);
		});
	});

	describe("Concurrency Option", () => {
		test("should respect concurrency limit for port checks", async () => {
			let active = 0;
			let maxActive = 0;
			mockServer.listen.mockImplementation((options, callback) => {
				active++;
				if (active > maxActive) maxActive = active;
				setTimeout(() => {
					active--;
					callback?.();
				}, 10);
				return mockServer;
			});
			const ports = [20004, 20005, 20006, 20007, 20008];
			await getOpenPort({ port: ports, concurrency: 2 });
			expect(maxActive).toBeLessThanOrEqual(2);
		});
	});
});
