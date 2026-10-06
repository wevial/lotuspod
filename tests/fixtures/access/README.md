Two 2048-bit RSA keys, both made for the tests only; nothing outside this
repository trusts either of them.

- `tests/fixtures/access/test-key.json` holds the test key whole, and
  `tests/fixtures/access/certs.json` its public half as an Access key set.
  `tests/access_keys.py` signs assertions with it.
- `tests/fixtures/access/witness-key.json` holds the witness key
  (`kid` `witness-key`) whole. The agent pull, answers, backup and responder
  witness tests sign their Access assertions with it, and the
  `lotuspod serve` each one starts is configured to trust its public half.
