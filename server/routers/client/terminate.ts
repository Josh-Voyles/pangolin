import { disconnectClient, sendToClient } from "#dynamic/routers/ws";
import { db, olms } from "@server/db";
import { eq } from "drizzle-orm";
import { OlmErrorCodes } from "../olm/error";
import logger from "@server/logger";

export async function sendTerminateClient(
    clientId: number,
    error: (typeof OlmErrorCodes)[keyof typeof OlmErrorCodes],
    olmId?: string | null
) {
    if (!olmId) {
        const [olm] = await db
            .select()
            .from(olms)
            .where(eq(olms.clientId, clientId))
            .limit(1);
        if (!olm) {
            throw new Error(`Olm with ID ${clientId} not found`);
        }
        olmId = olm.olmId;
    }

    await sendToClient(olmId, {
        type: `olm/terminate`,
        data: {
            code: error.code,
            message: error.message
        }
    });
}

/**
 * Send a terminate message to the OLM, then force-close the WebSocket
 * after a short delay so a misbehaving or unresponsive OLM stops pinging
 * the server. Mirrors the pattern in olm/offlineChecker.ts. Errors are
 * logged but not rethrown — by the time this runs the DB change that
 * motivated the disconnect has already committed.
 */
export async function terminateAndDisconnect(
    clientId: number,
    error: (typeof OlmErrorCodes)[keyof typeof OlmErrorCodes],
    olmId: string
): Promise<void> {
    try {
        await sendTerminateClient(clientId, error, olmId);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await disconnectClient(olmId);
    } catch (err) {
        logger.error("Failed to terminate and disconnect olm", {
            olmId,
            clientId,
            err
        });
    }
}
