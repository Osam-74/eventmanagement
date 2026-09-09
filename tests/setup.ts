// Test-only values — never real secrets.
process.env.QR_TOKEN_HMAC_KEY ??= 'test-hmac-key-0123456789abcdef0123456789abcdef';
process.env.USHER_PIN_PEPPER ??= 'test-pin-pepper-0123456789abcdef';
process.env.USHER_SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.ADMIN_SESSION_SECRET ??= 'test-admin-session-secret-0123456789abcd';
