import express from "express";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOAuthRouter, type ReviewOAuthOptions } from "../src/auth/oauth.js";
import { AuthStore } from "../src/auth/store.js";
import { nullLogger } from "../src/logger/index.js";
import { PairingManager } from "../src/pairing/manager.js";
import { cleanup, makeTmpDir, pkceVerifierAndChallenge } from "./helpers.js";

const ISSUER = "https://issuer.example.test/";
const RESOURCE = "https://mcp.example.test/review/mcp";
const REDIRECT_URI = "https://connector.example.test/oauth/callback";
const REVIEW: ReviewOAuthOptions = {
  isActive: () => true,
  expiresAt: Date.now() + 60_000,
  remote: { issuer: ISSUER, resource: RESOURCE, allowedRedirectUris: [REDIRECT_URI] },
};

let server: Server;
let base: string;
let store: AuthStore;
let pairing: PairingManager;
let stateDir: string;

beforeAll(async () => {
  stateDir = makeTmpDir("review-oauth-remote");
  store = new AuthStore("remote-review", { file: path.join(stateDir, "auth.json") });
  pairing = new PairingManager("remote-review");
  const app = express();
  app.use(createOAuthRouter({
    store,
    pairing,
    workspaceName: "Remote review test",
    getBaseUrl: () => "http://127.0.0.1:0",
    logger: nullLogger,
    review: REVIEW,
  }));
  server = await new Promise<Server>((resolve) => {
    const next = app.listen(0, "127.0.0.1", () => resolve(next));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  cleanup(stateDir);
});

async function register(redirectUri = REDIRECT_URI): Promise<Response> {
  return fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "remote-review-test", redirect_uris: [redirectUri] }),
  });
}

async function beginAuthorization(clientId: string, challenge: string, resource = RESOURCE): Promise<Response> {
  const request = new URL(`${base}/oauth/authorize`);
  request.searchParams.set("client_id", clientId);
  request.searchParams.set("redirect_uri", REDIRECT_URI);
  request.searchParams.set("response_type", "code");
  request.searchParams.set("code_challenge", challenge);
  request.searchParams.set("code_challenge_method", "S256");
  request.searchParams.set("scope", "workspace.read git.read");
  request.searchParams.set("resource", resource);
  return fetch(request, { redirect: "manual" });
}

describe("opt-in remote review OAuth", () => {
  it("rejects malformed remote policy before it can serve OAuth", () => {
    const baseDeps = {
      store,
      pairing,
      workspaceName: "Remote review test",
      getBaseUrl: () => "http://127.0.0.1:0",
      logger: nullLogger,
      review: REVIEW,
    };
    expect(() => createOAuthRouter({
      ...baseDeps,
      review: { ...REVIEW, remote: { ...REVIEW.remote!, issuer: "http://issuer.example.test/" } },
    })).toThrow("INVALID_REMOTE_REVIEW_ISSUER");
    expect(() => createOAuthRouter({
      ...baseDeps,
      review: { ...REVIEW, remote: { ...REVIEW.remote!, allowedRedirectUris: ["https://connector.example.test/oauth/*"] } },
    })).toThrow("INVALID_REMOTE_REVIEW_REDIRECT_URI");
  });

  it("publishes caller-supplied HTTPS issuer/resource despite arbitrary forwarded headers", async () => {
    const authorization = await fetch(`${base}/.well-known/oauth-authorization-server`, {
      headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" },
    });
    const authorizationBody = await authorization.json() as Record<string, unknown>;
    expect(authorizationBody.issuer).toBe(ISSUER);
    expect(authorizationBody.authorization_endpoint).toBe("https://issuer.example.test/oauth/authorize");
    expect(authorizationBody.token_endpoint).toBe("https://issuer.example.test/oauth/token");
    expect(authorizationBody.registration_endpoint).toBe("https://issuer.example.test/oauth/register");
    expect(authorizationBody.authorization_response_iss_parameter_supported).toBe(true);
    expect(authorizationBody.grant_types_supported).toEqual(["authorization_code"]);

    const resource = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
      headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" },
    });
    expect(await resource.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
  });

  it("requires an explicit exact HTTPS redirect allowlist", async () => {
    expect((await register()).status).toBe(201);
    for (const redirectUri of [
      "https://attacker.example.test/callback",
      "http://connector.example.test/oauth/callback",
      "https://connector.example.test/oauth/*",
      "https://user@connector.example.test/oauth/callback",
      "https://connector.example.test/oauth/callback#fragment",
    ]) {
      expect((await register(redirectUri)).status).toBe(400);
    }
  });

  it("binds authorization and token exchange to the configured resource with PKCE and no refresh", async () => {
    const registered = await register();
    const { client_id: clientId } = await registered.json() as { client_id: string };
    const { verifier, challenge } = pkceVerifierAndChallenge();

    const wrongResource = await beginAuthorization(clientId, challenge, "https://mcp.example.test/other/mcp");
    expect(wrongResource.status).toBe(302);
    const failedRedirect = new URL(wrongResource.headers.get("location")!);
    expect(failedRedirect.searchParams.get("error")).toBe("invalid_target");
    expect(failedRedirect.searchParams.get("iss")).toBe(ISSUER);

    const page = await beginAuthorization(clientId, challenge);
    expect(page.status).toBe(200);
    const requestId = (await page.text()).match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    expect(requestId).toBeTruthy();
    const codeResponse = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: pairing.create().code }),
      redirect: "manual",
    });
    const redirect = new URL(codeResponse.headers.get("location")!);
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirect.searchParams.get("iss")).toBe(ISSUER);

    const wrongTokenResource = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: code!, code_verifier: verifier, client_id: clientId,
        redirect_uri: REDIRECT_URI, resource: "https://mcp.example.test/other/mcp",
      }),
    });
    expect(await wrongTokenResource.json()).toEqual({ error: "invalid_target" });

    const pageAgain = await beginAuthorization(clientId, challenge);
    const requestIdAgain = (await pageAgain.text()).match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    const codeAgainResponse = await fetch(`${base}/oauth/authorize`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestIdAgain!, pairing_code: pairing.create().code }), redirect: "manual",
    });
    const codeAgain = new URL(codeAgainResponse.headers.get("location")!).searchParams.get("code");
    const token = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: codeAgain!, code_verifier: verifier, client_id: clientId,
        redirect_uri: REDIRECT_URI, resource: RESOURCE,
      }),
    });
    const tokenBody = await token.json() as Record<string, unknown>;
    expect(token.status).toBe(200);
    expect(tokenBody.refresh_token).toBeUndefined();
    expect(tokenBody.access_token).toMatch(/^c2c_at_/);
  });
});
