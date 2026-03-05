# Chirpy Network Protocol Schemas (v1)

This document defines interoperable JSON payloads for decentralized Chirpy nodes.
All schemas are public metadata only. Private keys never leave local nodes.

## 1) Public Profile Bundle

Purpose: publish a node/user identity bundle that other nodes can use for discovery and encryption targeting.

```json
{
  "$id": "chirpy.public-profile.v1",
  "type": "object",
  "required": ["schema", "did", "displayName", "encryptionPublicJwk", "updatedAt"],
  "properties": {
    "schema": { "const": "chirpy.public-profile/1.0.0" },
    "did": { "type": "string", "minLength": 8 },
    "displayName": { "type": "string", "minLength": 1, "maxLength": 80 },
    "nodeName": { "type": "string", "minLength": 3, "maxLength": 40 },
    "ipnsKey": { "type": "string" },
    "encryptionPublicJwk": {
      "type": "object",
      "required": ["kty"],
      "properties": {
        "kty": { "type": "string" },
        "n": { "type": "string" },
        "e": { "type": "string" },
        "alg": { "type": "string" },
        "kid": { "type": "string" }
      },
      "additionalProperties": true
    },
    "capabilities": {
      "type": "object",
      "properties": {
        "canPublish": { "type": "boolean" },
        "canModerateFamily": { "type": "boolean" }
      },
      "additionalProperties": false
    },
    "updatedAt": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

## 2) Presence Heartbeat

Purpose: lightweight live discovery over PubSub.

```json
{
  "$id": "chirpy.presence.v1",
  "type": "object",
  "required": ["schema", "id", "name", "timestamp"],
  "properties": {
    "schema": { "const": "chirpy.presence/1.0.0" },
    "id": { "type": "string", "minLength": 8 },
    "peerId": { "type": "string" },
    "name": { "type": "string", "minLength": 3, "maxLength": 40 },
    "profileDid": { "type": "string" },
    "version": { "type": "string" },
    "timestamp": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

## 3) Encrypted Post Manifest

Purpose: describe encrypted post payloads without exposing plaintext.

```json
{
  "$id": "chirpy.encrypted-post-manifest.v1",
  "type": "object",
  "required": ["schema", "post", "assets", "encryption"],
  "properties": {
    "schema": { "const": "chirpy.sovereign-post/1.0.0" },
    "post": {
      "type": "object",
      "required": ["id", "createdAt", "userDid", "visibility"],
      "properties": {
        "id": { "type": "string" },
        "createdAt": { "type": "string", "format": "date-time" },
        "userDid": { "type": "string" },
        "authorRole": { "type": "string", "enum": ["adult", "child"] },
        "visibility": { "type": "string", "enum": ["public", "family"] },
        "text": { "type": "string" },
        "tags": { "type": "array", "items": { "type": "string" } }
      },
      "additionalProperties": true
    },
    "assets": {
      "type": "object",
      "properties": {
        "photos": { "type": "array", "items": { "type": "object" } },
        "videos": { "type": "array", "items": { "type": "object" } },
        "links": { "type": "array", "items": { "type": "object" } }
      },
      "required": ["photos", "videos", "links"],
      "additionalProperties": false
    },
    "encryption": {
      "type": "object",
      "required": ["enabled", "algorithm", "recipients", "files"],
      "properties": {
        "enabled": { "type": "boolean", "const": true },
        "algorithm": { "type": "string", "enum": ["AES-GCM+RSA-OAEP-256"] },
        "recipients": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["did", "wrappedDek"],
            "properties": {
              "did": { "type": "string" },
              "wrappedDek": { "type": "string" }
            },
            "additionalProperties": false
          }
        },
        "files": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "required": ["encPath", "iv", "tag", "aad"],
            "properties": {
              "encPath": { "type": "string" },
              "mime": { "type": "string" },
              "iv": { "type": "string" },
              "tag": { "type": "string" },
              "aad": { "type": "string" }
            },
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": true
}
```

## Notes

- `profileDid`/DID and public encryption key are shareable.
- Private keys are never included in any protocol payload.
- Presence identity uniqueness is best-effort and time-window based.
- Node names should be validated against active presence records.
