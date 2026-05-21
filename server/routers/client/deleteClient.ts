import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db, olms } from "@server/db";
import { clients, clientSitesAssociationsCache } from "@server/db";
import { eq } from "drizzle-orm";
import response from "@server/lib/response";
import HttpCode from "@server/types/HttpCode";
import createHttpError from "http-errors";
import logger from "@server/logger";
import { fromError } from "zod-validation-error";
import { OpenAPITags, registry } from "@server/openApi";
import { rebuildClientAssociationsFromClient } from "@server/lib/rebuildClientAssociations";
import { terminateAndDisconnect } from "./terminate";
import { OlmErrorCodes } from "../olm/error";

const deleteClientSchema = z.strictObject({
    clientId: z.string().transform(Number).pipe(z.int().positive())
});

registry.registerPath({
    method: "delete",
    path: "/client/{clientId}",
    description: "Delete a client by its client ID.",
    tags: [OpenAPITags.Client],
    request: {
        params: deleteClientSchema
    },
    responses: {}
});

export async function deleteClient(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> {
    try {
        const parsedParams = deleteClientSchema.safeParse(req.params);
        if (!parsedParams.success) {
            return next(
                createHttpError(
                    HttpCode.BAD_REQUEST,
                    fromError(parsedParams.error).toString()
                )
            );
        }

        const { clientId } = parsedParams.data;

        const [client] = await db
            .select()
            .from(clients)
            .where(eq(clients.clientId, clientId))
            .limit(1);

        if (!client) {
            return next(
                createHttpError(
                    HttpCode.NOT_FOUND,
                    `Client with ID ${clientId} not found`
                )
            );
        }

        // Only allow deletion of machine clients (clients without userId)
        if (client.userId) {
            return next(
                createHttpError(
                    HttpCode.BAD_REQUEST,
                    `Cannot delete a user client. User clients must be archived instead.`
                )
            );
        }

        const toTerminate = await db.transaction(async (trx) => {
            // Then delete the client itself
            const [deletedClient] = await trx
                .delete(clients)
                .where(eq(clients.clientId, clientId))
                .returning();

            const [olm] = await trx
                .select()
                .from(olms)
                .where(eq(olms.clientId, clientId))
                .limit(1);

            // this is a machine client so we also delete the olm
            if (!client.userId && client.olmId) {
                await trx.delete(olms).where(eq(olms.olmId, client.olmId));
            }

            await rebuildClientAssociationsFromClient(deletedClient, trx);

            // Return termination data for after-commit handling; olmId has to
            // be captured here because it cant be looked up after deletion.
            return olm
                ? { clientId: deletedClient.clientId, olmId: olm.olmId }
                : null;
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
            message: "Client deleted successfully",
            status: HttpCode.OK
        });
    } catch (error) {
        logger.error(error);
        return next(
            createHttpError(HttpCode.INTERNAL_SERVER_ERROR, "An error occurred")
        );
    }
}
