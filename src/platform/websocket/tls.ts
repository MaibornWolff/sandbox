import type * as http from "node:http";
import * as https from "node:https";
import { generate } from "selfsigned";

export async function createListener(): Promise<{
  server: https.Server;
  certificate: string;
}> {
  const respond: http.RequestListener = (_request, response) => {
    response.writeHead(426).end();
  };
  const identity = await generate(
    [{ name: "commonName", value: "localhost" }],
    {
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          keyCertSign: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
      ],
    },
  );
  return {
    server: https.createServer(
      { key: identity.private, cert: identity.cert, minVersion: "TLSv1.2" },
      respond,
    ),
    certificate: identity.cert,
  };
}
