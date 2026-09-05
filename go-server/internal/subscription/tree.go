package subscription

import (
	"sort"
	"strings"
	"time"
)

// rateWindowMs is the sliding window used to compute per-subject message rates.
const rateWindowMs = 10_000

type SubjectNode struct {
	Segment      string        `json:"segment"`
	FullSubject  string        `json:"fullSubject"`
	MessageCount int           `json:"messageCount"`
	LastMessage  *NatsMessage  `json:"lastMessage,omitempty"`
	Children     []SubjectNode `json:"children"`
	Rate         float64       `json:"rate"`
}

type treeNode struct {
	segment      string
	fullSubject  string
	messageCount int
	lastMessage  *NatsMessage
	rate         float64
	children     map[string]*treeNode
}

// BuildTree turns the flat per-subject stats into a sorted hierarchical tree.
// Rates are only computed for leaf subjects; parents aggregate on the client.
func BuildTree(stats map[string]*SubjectStats) []SubjectNode {
	root := make(map[string]*treeNode)
	now := time.Now().UnixMilli()
	cutoff := now - rateWindowMs

	for subject, st := range stats {
		segments := strings.Split(subject, ".")
		current := root

		for i, seg := range segments {
			node, ok := current[seg]
			if !ok {
				node = &treeNode{
					segment:     seg,
					fullSubject: strings.Join(segments[:i+1], "."),
					children:    make(map[string]*treeNode),
				}
				current[seg] = node
			}

			if i == len(segments)-1 {
				node.messageCount = st.MessageCount
				node.lastMessage = st.LastMessage
				count := 0
				for _, t := range st.Timestamps {
					if t >= cutoff {
						count++
					}
				}
				node.rate = float64(count) / (rateWindowMs / 1000.0)
			}

			current = node.children
		}
	}

	return convertChildren(root)
}

func convertChildren(children map[string]*treeNode) []SubjectNode {
	result := make([]SubjectNode, 0, len(children))
	for _, n := range children {
		result = append(result, SubjectNode{
			Segment:      n.segment,
			FullSubject:  n.fullSubject,
			MessageCount: n.messageCount,
			LastMessage:  n.lastMessage,
			Children:     convertChildren(n.children),
			Rate:         n.rate,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Segment < result[j].Segment
	})
	return result
}
