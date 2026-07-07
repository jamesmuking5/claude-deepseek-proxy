// Generate CA + server certificates with proper extensions for BoringSSL/Chromium
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helper: PEM-encode DER data ─────────────────────────
function toPem(der, label) {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// ── Helper: Generate a key pair ──────────────────────────
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  // Export to DER for certificate building
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
  // Return KeyObjects for signing and DER for cert building
  return { publicKey, privateKey, publicDer, privateDer };
}

// ── Helper: Build X.509 v3 extensions as DER ────────────
// This is a minimal ASN.1 encoder for the extensions we need.
// We build the extensions blob manually since Node.js doesn't expose
// a full X.509 builder.

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let remaining = len;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  bytes.unshift(0x80 | bytes.length);
  return Buffer.from(bytes);
}

function encodeOID(oid) {
  const parts = oid.split(".").map(Number);
  const result = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    const bytes = [];
    bytes.unshift(val & 0x7f);
    val >>>= 7;
    while (val > 0) {
      bytes.unshift((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    result.push(...bytes);
  }
  return Buffer.from(result);
}

function encodeBitString(bits) {
  return Buffer.concat([Buffer.from([0]), bits]);
}

// Build a single extension: SEQUENCE { OID, critical?, OCTET STRING value }
function buildExtension(oid, critical, value) {
  const oidEncoded = Buffer.concat([
    Buffer.from([0x06]),
    encodeLength(oid.length),
    oid,
  ]);

  let extParts = [oidEncoded];
  if (critical) {
    extParts.push(Buffer.from([0x01, 0x01, 0xff])); // BOOLEAN TRUE
  }
  extParts.push(
    Buffer.concat([Buffer.from([0x04]), encodeLength(value.length), value])
  );

  const extData = Buffer.concat(extParts);
  return Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(extData.length),
    extData,
  ]);
}

// Build extensions blob: SEQUENCE of extensions
function buildExtensions(extensions) {
  const data = Buffer.concat(extensions);
  return Buffer.concat([Buffer.from([0x30]), encodeLength(data.length), data]);
}

// ── Build a self-signed CA certificate ───────────────────
function createCACert(keyPair) {
  const serial = crypto.randomBytes(8);
  // Serial number: ensure positive (clear high bit)
  serial[0] &= 0x7f;

  const now = Date.now();
  const notBefore = new Date(now - 86400000);
  const notAfter = new Date(now + 3650 * 86400000);

  // Subject: CN=Claude-DS Proxy CA, O=Local
  const subject = buildDN([
    ["2.5.4.10", "Local"],              // O
    ["2.5.4.3", "Claude-DS Proxy CA"], // CN
  ]);

  // SubjectPublicKeyInfo
  const spki = keyPair.publicDer;

  // Compute SubjectKeyIdentifier = SHA-1 hash of SPKI
  const ski = crypto.createHash("sha1").update(keyPair.publicDer).digest();
  const skiValue = Buffer.concat([
    Buffer.from([0x04]),
    encodeLength(ski.length),
    ski,
  ]);

  // Extensions for CA
  const extensions = buildExtensions([
    // Basic Constraints: CA:TRUE, critical
    buildExtension(
      Buffer.from(encodeOID("2.5.29.19")),
      true,
      Buffer.from([0x30, 0x03, 0x01, 0x01, 0xff]) // SEQUENCE { BOOLEAN TRUE }
    ),
    // Key Usage: keyCertSign + cRLSign, critical
    buildExtension(
      Buffer.from(encodeOID("2.5.29.15")),
      true,
      Buffer.from([0x03, 0x02, 0x01, 0x04]) // BIT STRING: keyCertSign(5) + cRLSign(6) → 0x04
    ),
    // Subject Key Identifier
    buildExtension(
      Buffer.from(encodeOID("2.5.29.14")),
      false,
      skiValue
    ),
  ]);

  // TBSCertificate
  const tbsCert = buildTBSCert({
    version: 2, // v3
    serial,
    signatureOID: "1.2.840.113549.1.1.11", // sha256WithRSAEncryption
    issuer: subject,
    validity: { notBefore, notAfter },
    subject,
    spki,
    extensions,
    issuerUniqueID: null,
    subjectUniqueID: null,
  });

  // Sign
  const tbsDer = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(tbsCert.length),
    tbsCert,
  ]);
  const signature = crypto.sign("sha256", tbsDer, keyPair.privateKey);

  // Build final certificate
  return buildCertificate(tbsCert, "1.2.840.113549.1.1.11", signature);
}

// ── Build a server certificate signed by CA ──────────────
function createServerCert(caKeyPair, caCertDer, caSki) {
  const keyPair = generateKeyPair();
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const now = Date.now();
  const notBefore = new Date(now - 86400000);
  const notAfter = new Date(now + 3650 * 86400000);

  // Subject: CN=localhost
  const subject = buildDN([
    ["2.5.4.3", "localhost"], // CN
  ]);

  // Issuer: CN=Claude-DS Proxy CA, O=Local
  const issuer = buildDN([
    ["2.5.4.10", "Local"],
    ["2.5.4.3", "Claude-DS Proxy CA"],
  ]);

  const spki = keyPair.publicDer;

  // Compute SubjectKeyIdentifier
  const ski = crypto.createHash("sha1").update(keyPair.publicDer).digest();
  const skiValue = Buffer.concat([
    Buffer.from([0x04]),
    encodeLength(ski.length),
    ski,
  ]);

  // Authority Key Identifier = keyid from CA SKI
  const akiValue = Buffer.concat([
    Buffer.from([0x30]), // SEQUENCE
    encodeLength(2 + ski.length),
    Buffer.from([0x80]), // [0] IMPLICIT (keyIdentifier)
    encodeLength(caSki.length),
    caSki,
  ]);

  // SAN: DNS:localhost, IP:127.0.0.1
  const sanValue = buildSAN([
    { type: "dns", value: "localhost" },
    { type: "ip", value: "127.0.0.1" },
  ]);

  const extensions = buildExtensions([
    // Basic Constraints: CA:FALSE
    buildExtension(
      Buffer.from(encodeOID("2.5.29.19")),
      false,
      Buffer.from([0x30, 0x00]) // empty SEQUENCE
    ),
    // Key Usage: digitalSignature + keyEncipherment, critical
    buildExtension(
      Buffer.from(encodeOID("2.5.29.15")),
      true,
      Buffer.from([0x03, 0x02, 0x05, 0xa0]) // digitalSignature(0) + keyEncipherment(2) → 0xa0 with padding
    ),
    // Extended Key Usage: serverAuth
    buildExtension(
      Buffer.from(encodeOID("2.5.29.37")),
      false,
      Buffer.concat([
        Buffer.from([0x30]),
        encodeLength(encodeOID("1.3.6.1.5.5.7.3.1").length + 2),
        Buffer.from([0x06]),
        encodeLength(encodeOID("1.3.6.1.5.5.7.3.1").length),
        Buffer.from(encodeOID("1.3.6.1.5.5.7.3.1")),
      ])
    ),
    // Subject Key Identifier
    buildExtension(
      Buffer.from(encodeOID("2.5.29.14")),
      false,
      skiValue
    ),
    // ★ Authority Key Identifier — THIS IS THE FIX ★
    buildExtension(
      Buffer.from(encodeOID("2.5.29.35")),
      false,
      akiValue
    ),
    // Subject Alternative Name
    buildExtension(
      Buffer.from(encodeOID("2.5.29.17")),
      false,
      sanValue
    ),
  ]);

  const tbsCert = buildTBSCert({
    version: 2,
    serial,
    signatureOID: "1.2.840.113549.1.1.11",
    issuer,
    validity: { notBefore, notAfter },
    subject,
    spki,
    extensions,
    issuerUniqueID: null,
    subjectUniqueID: null,
  });

  // Sign with CA key
  const tbsDer = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(tbsCert.length),
    tbsCert,
  ]);
  const signature = crypto.sign("sha256", tbsDer, caKeyPair.privateKey);

  return {
    cert: buildCertificate(tbsCert, "1.2.840.113549.1.1.11", signature),
    key: keyPair.privateDer,
  };
}

// ── ASN.1 Builder Helpers ───────────────────────────────

function buildDN(rdns) {
  // Each RDN: SET { SEQUENCE { OID, UTF8String } }
  const sets = rdns.map(([oid, value]) => {
    const attr = Buffer.concat([
      Buffer.from([0x30]),
      encodeLength(2 + encodeOID(oid).length + 2 + value.length),
      Buffer.from([0x06]),
      encodeLength(encodeOID(oid).length),
      Buffer.from(encodeOID(oid)),
      Buffer.from([0x0c]), // UTF8String
      encodeLength(value.length),
      Buffer.from(value, "utf8"),
    ]);
    return Buffer.concat([
      Buffer.from([0x31]), // SET
      encodeLength(attr.length),
      attr,
    ]);
  });
  const data = Buffer.concat(sets);
  return Buffer.concat([Buffer.from([0x30]), encodeLength(data.length), data]);
}

function buildSAN(entries) {
  const items = entries.map(({ type, value }) => {
    let tag, encoded;
    if (type === "dns") {
      tag = 0x82; // [2] IMPLICIT
      encoded = Buffer.from(value, "ascii");
    } else if (type === "ip") {
      tag = 0x87; // [7] IMPLICIT
      // Parse IPv4
      const parts = value.split(".").map(Number);
      encoded = Buffer.from(parts);
    }
    return Buffer.concat([
      Buffer.from([tag]),
      encodeLength(encoded.length),
      encoded,
    ]);
  });
  const data = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x30]), encodeLength(data.length), data]);
}

function buildTBSCert({ version, serial, signatureOID, issuer, validity, subject, spki, extensions, issuerUniqueID, subjectUniqueID }) {
  const parts = [];

  // Version: [0] EXPLICIT { INTEGER 2 }
  parts.push(
    Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02])
  );

  // Serial: INTEGER
  parts.push(
    Buffer.concat([
      Buffer.from([0x02]),
      encodeLength(serial.length),
      serial,
    ])
  );

  // Signature: SEQUENCE { OID, NULL }
  const sigAlg = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(encodeOID(signatureOID).length + 4),
    Buffer.from([0x06]),
    encodeLength(encodeOID(signatureOID).length),
    Buffer.from(encodeOID(signatureOID)),
    Buffer.from([0x05, 0x00]), // NULL
  ]);
  parts.push(sigAlg);

  // Issuer
  parts.push(issuer);

  // Validity
  const utcNotBefore = formatUTCTime(validity.notBefore);
  const utcNotAfter = formatUTCTime(validity.notAfter);
  const validitySeq = Buffer.concat([
    Buffer.from([0x17]), // UTCTime
    encodeLength(utcNotBefore.length),
    Buffer.from(utcNotBefore, "ascii"),
    Buffer.from([0x17]), // UTCTime
    encodeLength(utcNotAfter.length),
    Buffer.from(utcNotAfter, "ascii"),
  ]);
  parts.push(
    Buffer.concat([
      Buffer.from([0x30]),
      encodeLength(validitySeq.length),
      validitySeq,
    ])
  );

  // Subject
  parts.push(subject);

  // SubjectPublicKeyInfo (already DER-encoded)
  parts.push(spki);

  // Extensions: [3] EXPLICIT
  if (extensions) {
    parts.push(
      Buffer.concat([
        Buffer.from([0xa3]),
        encodeLength(extensions.length),
        extensions,
      ])
    );
  }

  return Buffer.concat(parts);
}

function buildCertificate(tbsCert, signatureOID, signature) {
  const sigAlg = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(encodeOID(signatureOID).length + 4),
    Buffer.from([0x06]),
    encodeLength(encodeOID(signatureOID).length),
    Buffer.from(encodeOID(signatureOID)),
    Buffer.from([0x05, 0x00]),
  ]);

  // Signature: BIT STRING
  const sigBitString = Buffer.concat([
    Buffer.from([0x00]), // unused bits
    signature,
  ]);
  const sigEncoded = Buffer.concat([
    Buffer.from([0x03]),
    encodeLength(sigBitString.length),
    sigBitString,
  ]);

  return Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(tbsCert.length + sigAlg.length + sigEncoded.length),
    tbsCert,
    sigAlg,
    sigEncoded,
  ]);
}

function formatUTCTime(date) {
  const y = date.getUTCFullYear().toString().slice(-2);
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  const h = date.getUTCHours().toString().padStart(2, "0");
  const min = date.getUTCMinutes().toString().padStart(2, "0");
  const s = date.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${m}${d}${h}${min}${s}Z`;
}

// ── Main ──────────────────────────────────────────────────
console.log("Generating CA certificate...");
const caKeyPair = generateKeyPair();
const caCertDer = createCACert(caKeyPair);
const caSki = crypto.createHash("sha1").update(caKeyPair.publicDer).digest();

console.log("Generating server certificate (with AKI)...");
const { cert: serverCertDer, key: serverKeyDer } = createServerCert(caKeyPair, caCertDer, caSki);

// Write PEM files
fs.writeFileSync(path.join(__dirname, "ca-cert.pem"), toPem(caCertDer, "CERTIFICATE"));
fs.writeFileSync(path.join(__dirname, "ca-key.pem"), toPem(caKeyPair.privateDer, "PRIVATE KEY"));
fs.writeFileSync(path.join(__dirname, "server-cert.pem"), toPem(serverCertDer, "CERTIFICATE"));
fs.writeFileSync(path.join(__dirname, "server-key.pem"), toPem(serverKeyDer, "PRIVATE KEY"));
fs.writeFileSync(
  path.join(__dirname, "server-fullchain.pem"),
  toPem(serverCertDer, "CERTIFICATE") + toPem(caCertDer, "CERTIFICATE")
);

console.log("\nCertificates generated:");
console.log("  ca-cert.pem        - CA certificate");
console.log("  ca-key.pem         - CA private key");
console.log("  server-cert.pem    - Server certificate (with AKI)");
console.log("  server-key.pem     - Server private key");
console.log("  server-fullchain.pem - Full chain (server + CA)");
console.log("\nIMPORTANT: Re-run 'install-ca.ps1' to update the CA in the trust store!");
