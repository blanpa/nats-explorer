package subscription

// rateWindowSec is the window a subject's rate is averaged over.
const rateWindowSec = 10

// rateBuckets counts messages per second over the last rateWindowSec
// seconds: one integer per second instead of one timestamp per message.
type rateBuckets struct {
	buckets [rateWindowSec]uint32
	// the second buckets[sec%rateWindowSec] belongs to; 0 before the first hit
	sec int64
}

// advance moves the window to sec, zeroing the seconds it skipped.
func (r *rateBuckets) advance(sec int64) {
	if r.sec == 0 {
		r.sec = sec
		return
	}
	if sec <= r.sec {
		return
	}
	if sec-r.sec >= rateWindowSec {
		r.buckets = [rateWindowSec]uint32{}
	} else {
		for s := r.sec + 1; s <= sec; s++ {
			r.buckets[s%rateWindowSec] = 0
		}
	}
	r.sec = sec
}

// hit records a message at nowMs.
func (r *rateBuckets) hit(nowMs int64) {
	sec := nowMs / 1000
	r.advance(sec)
	if sec >= r.sec {
		r.buckets[sec%rateWindowSec]++
	}
}

// value is the messages per second over the window ending at nowMs.
func (r *rateBuckets) value(nowMs int64) float64 {
	if r.sec == 0 {
		return 0
	}
	r.advance(nowMs / 1000)
	var sum uint32
	for _, b := range r.buckets {
		sum += b
	}
	return float64(sum) / rateWindowSec
}
