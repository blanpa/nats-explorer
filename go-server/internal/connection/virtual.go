package connection

import "fmt"

// Virtual connections carry data that is not live: an imported support
// bundle. They appear in the connection list so every module can read their
// recorded history, but nothing can be sent through them.

// AddVirtual registers a connection that has no NATS server behind it.
func (s *Store) AddVirtual(st Status) {
	st.Connected = false
	st.Bundle = true
	if st.Color == "" {
		st.Color = "#8b8fa3"
	}
	s.mu.Lock()
	s.virtual[st.ID] = st
	s.mu.Unlock()
	if s.onChange != nil {
		s.onChange()
	}
}

// RemoveVirtual forgets one; unknown ids are ignored.
func (s *Store) RemoveVirtual(id string) bool {
	s.mu.Lock()
	_, ok := s.virtual[id]
	delete(s.virtual, id)
	s.mu.Unlock()
	if ok && s.onChange != nil {
		s.onChange()
	}
	return ok
}

// IsVirtual reports whether an id belongs to a bundle.
func (s *Store) IsVirtual(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.virtual[id]
	return ok
}

// virtualStatuses returns a copy of the registered bundles.
func (s *Store) virtualStatuses() []Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Status, 0, len(s.virtual))
	for _, st := range s.virtual {
		out = append(out, st)
	}
	return out
}

// errVirtual is what a caller gets when it tries to use a bundle like a
// server.
func errVirtual(id string) error {
	return fmt.Errorf("%q is an imported bundle: it holds recorded messages and cannot be published to", id)
}
