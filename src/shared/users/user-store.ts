/**
 * Basic user management. Handles creation and tracking of proxy users, personal
 * access tokens, and quota management. Supports in-memory and Firebase Realtime
 * Database persistence stores.
 *
 * Users are identified solely by their personal access token. The token is
 * used to authenticate the user for all proxied requests.
 */

import admin from "firebase-admin";
import schedule from "node-schedule";
import { v4 as uuid } from "uuid";
import { config, getFirebaseApp } from "../../config";
import { ModelFamily } from "../models";
import { logger } from "../../logger";
import { User, UserUpdate } from "./schema";

const log = logger.child({ module: "users" });

const MAX_IPS_PER_USER = config.maxIpsPerUser;

const users: Map<string, User> = new Map();
const usersToFlush = new Set<string>();
let quotaRefreshJob: schedule.Job | null = null;
let userCleanupJob: schedule.Job | null = null;

export async function init() {
  log.info({ store: config.gatekeeperStore }, "Initializing user store...");
  if (config.gatekeeperStore === "firebase_rtdb") {
    await initFirebase();
  }
  if (config.quotaRefreshPeriod) {
    const crontab = getRefreshCrontab();
    quotaRefreshJob = schedule.scheduleJob(crontab, refreshAllQuotas);
    if (!quotaRefreshJob) {
      throw new Error(
        "Unable to schedule quota refresh. Is QUOTA_REFRESH_PERIOD set correctly?"
      );
    }
    log.debug(
      { nextRefresh: quotaRefreshJob.nextInvocation() },
      "Scheduled token quota refresh."
    );
  }

  userCleanupJob = schedule.scheduleJob("* * * * *", cleanupExpiredTokens);

  log.info("User store initialized.");
}

/**
 * Creates a new user and returns their token. Optionally accepts parameters
 * for setting an expiry date and/or token limits for temporary users.
 **/
export function createUser(createOptions?: {
  type?: User["type"];
  expiresAt?: number;
  tokenLimits?: User["tokenLimits"];
}) {
  const token = uuid();
  const newUser: User = {
    token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { turbo: 0, gpt4: 0, "gpt4-32k": 0, claude: 0 },
    tokenLimits: createOptions?.tokenLimits ?? { ...config.tokenQuota },
    createdAt: Date.now(),
  };

  if (createOptions?.type === "temporary") {
    Object.assign(newUser, {
      type: "temporary",
      expiresAt: createOptions.expiresAt,
    });
  } else {
    Object.assign(newUser, { type: createOptions?.type ?? "normal" });
  }

  users.set(token, newUser);
  usersToFlush.add(token);
  return token;
}

/** Returns the user with the given token if they exist. */
export function getUser(token: string) {
  return users.get(token);
}

/** Returns a list of all users. */
export function getUsers() {
  return Array.from(users.values()).map((user) => ({ ...user }));
}

/**
 * Upserts the given user. Intended for use with the /admin API for updating
 * arbitrary fields on a user; use the other functions in this module for
 * specific use cases. `undefined` values are left unchanged. `null` will delete
 * the property from the user.
 *
 * Returns the upserted user.
 */
export function upsertUser(user: UserUpdate) {
  const existing: User = users.get(user.token) ?? {
    token: user.token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { turbo: 0, gpt4: 0, "gpt4-32k": 0, claude: 0 },
    tokenLimits: { ...config.tokenQuota },
    createdAt: Date.now(),
  };

  const updates: Partial<User> = {};

  for (const field of Object.entries(user)) {
    const [key, value] = field as [keyof User, any]; // already validated by zod
    if (value === undefined || key === "token") continue;
    if (value === null) {
      delete existing[key];
    } else {
      updates[key] = value;
    }
  }

  // TODO: Write firebase migration to backfill gpt4-32k token counts
  if (updates.tokenCounts) {
    updates.tokenCounts["gpt4-32k"] ??= 0;
  }
  if (updates.tokenLimits) {
    updates.tokenLimits["gpt4-32k"] ??= 0;
  }

  users.set(user.token, Object.assign(existing, updates));
  usersToFlush.add(user.token);

  // Immediately schedule a flush to the database if we're using Firebase.
  if (config.gatekeeperStore === "firebase_rtdb") {
    setImmediate(flushUsers);
  }

  return users.get(user.token);
}

/** Increments the prompt count for the given user. */
export function incrementPromptCount(token: string) {
  const user = users.get(token);
  if (!user) return;
  user.promptCount++;
  usersToFlush.add(token);
}

/** Increments token consumption for the given user and model. */
export function incrementTokenCount(
  token: string,
  model: string,
  consumption: number
) {
  const user = users.get(token);
  if (!user) return;
  const modelFamily = getModelFamilyForQuotaUsage(model);
  user.tokenCounts[modelFamily] ??= 0;
  user.tokenCounts[modelFamily] += consumption;
  usersToFlush.add(token);
}

/**
 * Given a user's token and IP address, authenticates the user and adds the IP
 * to the user's list of IPs. Returns the user if they exist and are not
 * disabled, otherwise returns undefined.
 */
export function authenticate(token: string, ip: string) {
  const user = users.get(token);
  if (!user || user.disabledAt) return;
  if (!user.ip.includes(ip)) user.ip.push(ip);

  // If too many IPs are associated with the user, disable the account.
  const ipLimit =
    user.type === "special" || !MAX_IPS_PER_USER ? Infinity : MAX_IPS_PER_USER;
  if (user.ip.length > ipLimit) {
    disableUser(token, "IP address limit exceeded.");
    return;
  }

  user.lastUsedAt = Date.now();
  usersToFlush.add(token);
  return user;
}

export function hasAvailableQuota(
  token: string,
  model: string,
  requested: number
) {
  const user = users.get(token);
  if (!user) return false;
  if (user.type === "special") return true;

  const modelFamily = getModelFamilyForQuotaUsage(model);
  const { tokenCounts, tokenLimits } = user;
  const tokenLimit = tokenLimits[modelFamily];

  if (!tokenLimit) return true;

  const tokensConsumed = (tokenCounts[modelFamily] ?? 0) + requested;
  return tokensConsumed < tokenLimit;
}

export function refreshQuota(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenCounts, tokenLimits } = user;
  const quotas = Object.entries(config.tokenQuota) as [ModelFamily, number][];
  quotas
    // If a quota is not configured, don't touch any existing limits a user may
    // already have been assigned manually.
    .filter(([, quota]) => quota > 0)
    .forEach(
      ([model, quota]) =>
        (tokenLimits[model] = (tokenCounts[model] ?? 0) + quota)
    );
  usersToFlush.add(token);
}

export function resetUsage(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenCounts } = user;
  const counts = Object.entries(tokenCounts) as [ModelFamily, number][];
  counts.forEach(([model]) => (tokenCounts[model] = 0));
  usersToFlush.add(token);
}

/** Disables the given user, optionally providing a reason. */
export function disableUser(token: string, reason?: string) {
  const user = users.get(token);
  if (!user) return;
  user.disabledAt = Date.now();
  user.disabledReason = reason;
  usersToFlush.add(token);
}

export function getNextQuotaRefresh() {
  if (!quotaRefreshJob) return "never (manual refresh only)";
  return quotaRefreshJob.nextInvocation().getTime();
}

/**
 * Cleans up expired temporary tokens by disabling tokens past their access
 * expiry date and permanently deleting tokens one day after their access
 * expiry date.
 */
function cleanupExpiredTokens() {
  const now = Date.now();
  let disabled = 0;
  let deleted = 0;
  for (const user of users.values()) {
    if (user.type !== "temporary") continue;
    if (user.expiresAt && user.expiresAt < now && !user.disabledAt) {
      disableUser(user.token, "Temporary token expired.");
      disabled++;
    }
    if (user.disabledAt && user.disabledAt + 24 * 60 * 60 * 1000 < now) {
      users.delete(user.token);
      usersToFlush.add(user.token);
      deleted++;
    }
  }
  log.debug({ disabled, deleted }, "Expired tokens cleaned up.");
}

function refreshAllQuotas() {
  let count = 0;
  for (const user of users.values()) {
    if (user.type === "temporary") continue;
    refreshQuota(user.token);
    count++;
  }
  log.info(
    { refreshed: count, nextRefresh: quotaRefreshJob!.nextInvocation() },
    "Token quotas refreshed."
  );
}

// TODO: Firebase persistence is pretend right now and just polls the in-memory
// store to sync it with Firebase when it changes. Will refactor to abstract
// persistence layer later so we can support multiple stores.
let firebaseTimeout: NodeJS.Timeout | undefined;

async function initFirebase() {
  log.info("Connecting to Firebase...");
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref("users");
  const snapshot = await usersRef.once("value");
  const users: Record<string, User> | null = snapshot.val();
  firebaseTimeout = setInterval(flushUsers, 20 * 1000);
  if (!users) {
    log.info("No users found in Firebase.");
    return;
  }
  for (const token in users) {
    upsertUser(users[token]);
  }
  usersToFlush.clear();
  const numUsers = Object.keys(users).length;
  log.info({ users: numUsers }, "Loaded users from Firebase");
}

async function flushUsers() {
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref("users");
  const updates: Record<string, User> = {};
  const deletions = [];

  for (const token of usersToFlush) {
    const user = users.get(token);
    if (!user) {
      deletions.push(token);
      continue;
    }
    updates[token] = user;
  }

  usersToFlush.clear();

  const numUpdates = Object.keys(updates).length + deletions.length;
  if (numUpdates === 0) {
    return;
  }

  await usersRef.update(updates);
  await Promise.all(deletions.map((token) => usersRef.child(token).remove()));
  log.info(
    { users: Object.keys(updates).length, deletions: deletions.length },
    "Flushed changes to Firebase"
  );
}

// TODO: use key-management/models.ts for family mapping
function getModelFamilyForQuotaUsage(model: string): ModelFamily {
  if (model.includes("32k")) {
    return "gpt4-32k";
  }
  if (model.startsWith("gpt-4")) {
    return "gpt4";
  }
  if (model.startsWith("gpt-3.5")) {
    return "turbo";
  }
  return "claude";
}

function getRefreshCrontab() {
  switch (config.quotaRefreshPeriod!) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return "0 0 * * *";
    default:
      return config.quotaRefreshPeriod ?? "0 0 * * *";
  }
}
