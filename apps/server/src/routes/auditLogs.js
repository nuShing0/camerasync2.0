import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { 
    atLeast,
    getSessionRole
} from "../middleware/groupRole";

export const auditLogRouter = Router();

auditLogRouter.get("/audit-logs", requireAuth, async (req, res, next) => {
    try{
        const role = await getSessionRole(req.params.id, req.user.id);
        if(!role){
            return res.status(404).json({ error: "Session not found." });
        }

        if(!atLeast(role, "admin")){
            return res.status(403).json({ error: "Only group admins can view the downloads audit log" });
        }
    } catch(err){

    }
});

auditLogRouter.get("/audit-logs/export", requireAuth, async (req, res, next) => {
    try{
        const role = await getSessionRole(req.params.id, req.user.id);
        if(!role){
            return res.status(404).json({ error: "Session not found." });
        }

        if(!atLeast(role, "admin")){
            return res.status(403).json({ error: "Only group admins can view the downloads audit log" });
        }
    } catch(err){

    }
});