import { ProxyReqMutator } from "../index";

/**
 * Removes origin and referer headers before sending the request to the API for
 * privacy reasons.
 */
export const stripHeaders: ProxyReqMutator = (manager) => {
  manager.setHeader("origin", "");
  manager.setHeader("referer", "");
  manager.removeHeader("tailscale-user-login");
  manager.removeHeader("tailscale-user-name");
  manager.removeHeader("tailscale-headers-info");
  manager.removeHeader("tailscale-user-profile-pic");
  manager.removeHeader("cf-connecting-ip");
  manager.removeHeader("forwarded");
  manager.removeHeader("true-client-ip");
  manager.removeHeader("x-forwarded-for");
  manager.removeHeader("x-forwarded-host");
  manager.removeHeader("x-forwarded-proto");
  manager.removeHeader("x-real-ip");
};
