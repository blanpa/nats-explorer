package history

import (
	"context"
	"strings"
)

// Clearing the history of one subject, or of a subject and everything below
// it. Someone who wants a fresh look at one machine should not have to throw
// away what every other subject collected.

// DropMatching forgets the recorded messages of one subject and, with
// branch, of every subject below it. It returns the subjects it emptied.
func (s *MemStore) DropMatching(connID, subject string, branch bool) []string {
	if subject == "" {
		return nil
	}
	prefix := subject + "."
	var gone []string
	for _, sh := range s.shards {
		sh.mu.Lock()
		if ch := sh.conns[connID]; ch != nil {
			for subj, buf := range ch.subjects {
				if subj != subject && !(branch && strings.HasPrefix(subj, prefix)) {
					continue
				}
				for i := 0; i < buf.len(); i++ {
					sh.kill(buf.at(i))
				}
				delete(ch.subjects, subj)
				gone = append(gone, subj)
			}
			if len(ch.subjects) == 0 {
				delete(sh.conns, connID)
			}
		}
		sh.mu.Unlock()
	}
	return gone
}

// DropMatching on the tee also clears the persisted copy: a subject the user
// asked to forget should not come back from a time range.
func (t *Tee) DropMatching(connID, subject string, branch bool) []string {
	gone := t.MemStore.DropMatching(connID, subject, branch)
	if t.DB != nil {
		t.DB.DeleteSubject(context.Background(), connID, subject, branch)
	}
	return gone
}

// DeleteSubject removes the persisted messages and minute aggregates of a
// subject, and with branch of everything below it.
func (d *DB) DeleteSubject(ctx context.Context, connID, subject string, branch bool) error {
	where := "conn = ? AND subject = ?"
	args := []interface{}{connID, subject}
	if branch {
		where = `conn = ? AND (subject = ? OR subject LIKE ? ESCAPE '\')`
		args = append(args, likePrefix(subject)+".%")
	}
	res, err := d.db.ExecContext(ctx, `DELETE FROM messages WHERE `+where, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		d.count.Add(-n)
	}
	_, err = d.db.ExecContext(ctx, `DELETE FROM rollups WHERE `+where, args...)
	return err
}
