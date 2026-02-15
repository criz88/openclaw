import type { GatewayRequestHandlers } from "./types.js";
import { VERSION } from "../../version.js";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "../server-methods-list.js";

function buildGatewayMeta() {
  return {
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    methods: listGatewayMethods(),
    events: GATEWAY_EVENTS,
  };
}

export const metaHandlers: GatewayRequestHandlers = {
  "meta.get": ({ respond }) => {
    respond(true, buildGatewayMeta(), undefined);
  },
  // Backward/forward compatibility: different clients used different meta method names.
  meta: ({ respond }) => {
    respond(true, buildGatewayMeta(), undefined);
  },
  "gateway.meta": ({ respond }) => {
    respond(true, buildGatewayMeta(), undefined);
  },
  "system.meta": ({ respond }) => {
    respond(true, buildGatewayMeta(), undefined);
  },
  // Some desktop clients probe these during initial discovery.
  "capabilities.list": ({ respond }) => {
    respond(true, { items: listGatewayMethods() }, undefined);
  },
  "capabilities.get": ({ respond }) => {
    respond(true, { items: listGatewayMethods() }, undefined);
  },
  capabilities: ({ respond }) => {
    respond(true, { items: listGatewayMethods() }, undefined);
  },
  "gateway.capabilities": ({ respond }) => {
    respond(true, { items: listGatewayMethods() }, undefined);
  },
};
