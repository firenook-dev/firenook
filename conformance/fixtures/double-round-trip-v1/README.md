# Double round-trip oracle

Captured on 2026-11-21 from the pinned official Java emulator 1.22.0, using
Java 25.0.1 and Node 24.20.0 locally. A fresh oracle recording.

A client writes a double as a JSON number in its shortest decimal form: the
web SDK and any JavaScript client send `JSON.stringify`'s digits, which name
exactly one double. Read correctly rounded, the number is the double that was
written. **762 doubles** (one a client was seen to read back a unit in the
last place lower, boundaries such as `5e-324` and `1e+21`, 500 random finite
bit patterns from a fixed SplitMix64 seed and 250 computed decimals such as
`step * 0.0175 / 3 - 37`) are written twice, as arrays of 250 per document:

- `rest-patch`: REST `PATCH`, the body built with `JSON.stringify`;
- `browser-set`: the Firebase browser SDK's `setDoc`, over WebChannel;

and each document is read back three ways:

- `rest-get`: REST `GET`, the answer's numbers parsed by `JSON.parse`;
- `grpc-get`: gRPC `GetDocument` through `@google-cloud/firestore`'s v1 client;
- `browser-get`: the browser SDK's `getDocFromServer`.

Safe integers are left out, because the web SDK writes those as
`integerValue`. Each read is recorded as every value's IEEE 754 bits; there is
no envelope or timestamp comparison.

Observed: all six write and read pairs return every value with the bits that
were written (`verifyDoubleCapture`). That is the requirement the replay
checks, not the server's choice of decimal text: the Java emulator prints
`1.0E-7` where another server may print `1e-7`.

Reproduce (a fresh output directory only):

```sh
JAVA=/path/to/java node --import tsx src/serialization/capture-doubles.ts \
  --output /new/capture/java-1.22.0
```

`FIRESTORE_EMULATOR_JAR` can supply the exact checksum-pinned JAR. `CHROME_BIN`
can select installed Chrome. For replay, `--origin http://127.0.0.1:PORT` uses
an isolated local Firenook instance with open rules; cloud endpoints are
refused. The command runs from `conformance/`. Only isolated synthetic
documents are used.
