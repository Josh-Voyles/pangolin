import { getClientConfigVersion } from "#dynamic/routers/ws";
import { db } from "@server/db";
import { MessageHandler } from "@server/routers/ws";
import { clients, Olm } from "@server/db";
import { eq } from "drizzle-orm";
import { recordClientPing } from "@server/routers/newt/pingAccumulator";
import logger from "@server/logger";
import { validateSessionToken } from "@server/auth/sessions/app";
import { checkOrgAccessPolicy } from "#dynamic/lib/checkOrgAccessPolicy";
import { encodeHexLowerCase } from "@oslojs/encoding";
import { sha256 } from "@oslojs/crypto/sha2";
import { sendOlmSyncMessage } from "./sync";
import { handleFingerprintInsertion } from "./fingerprintingUtils";

// Throttle expensive operations (session validation, config sync, fingerprint)
// to once every 5 minutes per OLM. The cheap PK lookup that checks
// `clients.blocked` still runs every ping so admin block actions take effect
// immediately via the offline checker.
const FULL_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const lastFullCheck: Map<string, number> = new Map();

/**
 * Drop a per-OLM throttle entry. Called from the WS close handler so the
 * map doesn't accumulate entries for the process lifetime as OLMs churn.
 */
export function evictOlmPingState(olmId: string): void {
    lastFullCheck.delete(olmId);
}

/**
 * Handles ping messages from clients and responds with pong
 */
export const handleOlmPingMessage: MessageHandler = async (context) => {
    const { message, client: c, sendToClient } = context;
    const olm = c as Olm;

    const { userToken, fingerprint, postures } = message.data;

    if (!olm) {
        logger.warn("Olm not found");
        return;
    }

    if (!olm.clientId) {
        logger.warn("Olm has no client ID!");
        return;
    }

    const isUserDevice = olm.userId !== null && olm.userId !== undefined;

    const now = Date.now();
    const lastCheck = lastFullCheck.get(olm.olmId) || 0;
    const needsFullCheck = now - lastCheck >= FULL_CHECK_INTERVAL_MS;

    try {
        // Fast-path: single PK SELECT on every ping. Cheap enough to run
        // unthrottled, and gating recordClientPing on the blocked check
        // preserves the offline-checker-driven disconnect path for blocked
        // clients. Selects the full row because sendOlmSyncMessage needs it
        // on the slow-path config-mismatch branch.
        const [client] = await db
            .select()
            .from(clients)
            .where(eq(clients.clientId, olm.clientId))
            .limit(1);

        if (!client) {
            logger.warn("Client not found for olm ping");
            return;
        }

        if (client.blocked) {
            // NOTE: by returning we dont update the lastPing, so the offline
            // checker will eventually disconnect them.
            logger.debug(
                `Blocked client ${client.clientId} attempted olm ping`
            );
            return;
        }

        if (needsFullCheck) {
            // Slow-path: session validation, policy, config sync, fingerprint.
            if (olm.userId) {
                const { session: userSession, user } =
                    await validateSessionToken(userToken);
                if (!userSession || !user) {
                    logger.warn("Invalid user session for olm ping");
                    return;
                }
                if (user.userId !== olm.userId) {
                    logger.warn("User ID mismatch for olm ping");
                    return;
                }
                if (user.userId !== client.userId) {
                    logger.warn("Client user ID mismatch for olm ping");
                    return;
                }

                const sessionId = encodeHexLowerCase(
                    sha256(new TextEncoder().encode(userToken))
                );

                const policyCheck = await checkOrgAccessPolicy({
                    orgId: client.orgId,
                    userId: olm.userId,
                    sessionId
                });

                if (!policyCheck.allowed) {
                    logger.warn(
                        `Olm user ${olm.userId} does not pass access policies for org ${client.orgId}: ${policyCheck.error}`
                    );
                    return;
                }
            }

            const configVersion = await getClientConfigVersion(olm.olmId);

            if (
                message.configVersion != null &&
                configVersion != null &&
                configVersion != message.configVersion
            ) {
                logger.debug(
                    `handleOlmPingMessage: Olm ping with outdated config version: ${message.configVersion} (current: ${configVersion})`
                );
                await sendOlmSyncMessage(olm, client);
            }

            if (isUserDevice) {
                await handleFingerprintInsertion(olm, fingerprint, postures);
            }

            lastFullCheck.set(olm.olmId, now);
        }

        recordClientPing(olm.clientId, olm.olmId, !!olm.archived);
    } catch (error) {
        logger.error("Error handling ping message", { error });
    }

    return {
        message: {
            type: "pong",
            data: {
                timestamp: new Date().toISOString()
            }
        },
        broadcast: false,
        excludeSender: false
    };
};
