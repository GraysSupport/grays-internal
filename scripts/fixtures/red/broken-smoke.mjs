// Fixture: a suite that fails the way real suites do — a thrown check → uncaught → exit 1.
// The self-test points the real runner at this dir and asserts the runner exits non-zero.
throw new Error('FAIL: deliberate fixture failure');
