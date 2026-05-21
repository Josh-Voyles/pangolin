import { NextFunction, Request, Response } from "express";
import { Client, db } from "@server/db";
import { olms, clients, clientSitesAssociationsCache } from "@server/db";
import { eq } from "drizzle-orm";
import HttpCode from "@server/types/HttpCode";
import createHttpError from "http-errors";
import response from "@server/lib/response";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import logger from "@server/logger";
import { OpenAPITags, registry } from "@server/openApi";
import { rebuildClientAssociationsFromClient } from "@server/lib/rebuildClientAssociations";
import { terminateAndDisconnect } from "../client/terminate";
import { OlmErrorCodes } from "./error";

const paramsSchema = z
    .object({
        userId: z.string(),
        olmId: z.string()
    })
    .strict();

// registry.registerPath({
//     method: "delete",
//     path: "/user/{userId}/olm/{olmId}",
//     description: "Delete an olm for a user.",
//     tags: [OpenAPITags.User, OpenAPITags.Client],
//     request: {
//         params: paramsSchema
//     },
//     responses: {}
// });

export async function deleteUserOlm(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> {
    try {
        const parsedParams = paramsSchema.safeParse(req.params);
        if (!parsedParams.success) {
            return next(
                createHttpError(
                    HttpCode.BAD_REQUEST,
                    fromError(parsedParams.error).toString()
                )
            );
        }

        const { olmId } = parsedParams.data;

        // Delete associated clients and the OLM in a transaction
        const toTerminate = await db.transaction(async (trx) => {
            // Find all clients associated with this OLM
            const associatedClients = await trx
                .select({ clientId: clients.clientId })
                .from(clients)
                .where(eq(clients.olmId, olmId));

            let deletedClient: Client | null = null;
            // Delete all associated clients
            if (associatedClients.length > 0) {
                [deletedClient] = await trx
                    .delete(clients)
                    .where(eq(clients.olmId, olmId))
                    .returning();
            }

            // Finally, delete the OLM itself
            const [olm] = await trx
                .delete(olms)
                .where(eq(olms.olmId, olmId))
                .returning();

            if (deletedClient) {
                await rebuildClientAssociationsFromClient(deletedClient, trx);
                if (olm) {
                    // Return termination data; olmId has to be captured here
                    // because it cant be looked up after deletion.
                    return {
                        clientId: deletedClient.clientId,
                        olmId: olm.olmId
                    };
                }
            }
            return null;
        });

        if (toTerminate) {
            await terminateAndDisconnect(
                toTerminate.clientId,
                OlmErrorCodes.TERMINATED_DELETED,
                toTerminate.olmId
            );
        }

        return response(res, {
            data: null,
            success: true,
            error: false,
            message: "Device deleted successfully",
            status: HttpCode.OK
        });
    } catch (error) {
        logger.error(error);
        return next(
            createHttpError(
                HttpCode.INTERNAL_SERVER_ERROR,
                "Failed to delete device"
            )
        );
    }
}
