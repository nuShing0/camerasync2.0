import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { 
    atLeast,
    getSessionRole
} from "../middleware/groupRole.js";
import { pool } from "../db/pool.js";

// mergeParams: true allows this router to access the :id parameter if mounted under a parent route
export const auditLogRouter = Router({ mergeParams: true });

auditLogRouter.get("/audit-logs", requireAuth, async (req, res, next) => {
    try {
        const role = await getSessionRole(req.params.id, req.user.id);
        if (!role) {
            return res.status(404).json({ error: "Session not found." });
        }

        if (!atLeast(role, "admin")) {
            return res.status(403).json({ error: "Only group admins can view the downloads audit log" });
        }

        const { rows } = await pool.query(`
            SELECT d.id, d.downloaded_at, d.file_type, d.file_id, d.ip_address,
                   u.display_name, u.email
            FROM download_logs d
            LEFT JOIN users u ON d.user_id = u.user_id
            WHERE d.session_id = $1
            ORDER BY d.downloaded_at DESC
        `, [req.params.id]);

        return res.json({ logs: rows });
    } catch (err) {
        //  passes database/execution errors to Express instead of hanging
        next(err);
    }
});

auditLogRouter.get("/audit-logs/export", requireAuth, async (req, res, next) => {
    try {
        const role = await getSessionRole(req.params.id, req.user.id);
        if (!role) {
            return res.status(404).json({ error: "Session not found." });
        }

        if (!atLeast(role, "admin")) {
            return res.status(403).json({ error: "Only group admins can view the downloads audit log" });
        }

        // For large datasets this might need to stream from the DB directly
        const { rows } = await pool.query(`
            SELECT d.downloaded_at, d.file_id, u.display_name, u.email, d.ip_address
            FROM download_logs d
            LEFT JOIN users u ON d.user_id = u.user_id
            WHERE d.session_id = $1
            ORDER BY d.downloaded_at DESC
        `, [req.params.id]);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="session-${req.params.id}-downloads.csv"`);

        res.write("Timestamp,File ID,User,Email,IP Address\n");
        
        for (const row of rows) {
            const date = new Date(row.downloaded_at).toISOString();
            
            //Strings are wrapped in quotes and internal quotes are escaped 
            // to prevent commas inside names from breaking the CSV structure
            const name = `"${(row.display_name || 'Unknown').replace(/"/g, '""')}"`;
            const email = `"${(row.email || '').replace(/"/g, '""')}"`;
            
            res.write(`${date},${row.file_id},${name},${email},${row.ip_address}\n`);
        }

        return res.end();
    } catch (err) {
        next(err);
    }
});