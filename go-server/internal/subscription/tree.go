package subscription

import (
	"sort"
	"strings"
	"time"
)

type SubjectNode struct {
	Segment      string        `json:"segment"`
	FullSubject  string        `json:"fullSubject"`
	MessageCount int           `json:"messageCount"`
	LastMessage  *NatsMessage  `json:"lastMessage,omitempty"`
	Children     []SubjectNode `json:"children"`
	Rate         float64       `json:"rate"`
}

func BuildTree(stats map[string]*SubjectStats) []SubjectNode {
	root := make(map[string]*SubjectNode)
	now := time.Now().UnixMilli()

	for subject, st := range stats {
		segments := strings.Split(subject, ".")
		currentLevel := root

		for i, seg := range segments {
			fullSubject := strings.Join(segments[:i+1], ".")
			node, ok := currentLevel[seg]
			if !ok {
				node = &SubjectNode{
					Segment:     seg,
					FullSubject: fullSubject,
					Children:    nil,
				}
				currentLevel[seg] = node
			}

			if i == len(segments)-1 {
				node.MessageCount = st.MessageCount
				node.LastMessage = st.LastMessage
				// Calculate rate
				count := 0
				cutoff := now - 10000
				for _, t := range st.Timestamps {
					if t >= cutoff {
						count++
					}
				}
				node.Rate = float64(count) / 10.0
			}

			// Build next level map from children
			if i < len(segments)-1 {
				childMap := make(map[string]*SubjectNode)
				if node.Children != nil {
					for idx := range node.Children {
						childMap[node.Children[idx].Segment] = &node.Children[idx]
					}
				}
				currentLevel = childMap
				// We need to rebuild children from the map after processing
				// This is tricky with the map approach, let's use a simpler recursive builder
			}
		}
	}

	// Actually let's use a cleaner approach
	return buildTreeClean(stats)
}

func buildTreeClean(stats map[string]*SubjectStats) []SubjectNode {
	type treeNode struct {
		segment      string
		fullSubject  string
		messageCount int
		lastMessage  *NatsMessage
		rate         float64
		children     map[string]*treeNode
	}

	rootChildren := make(map[string]*treeNode)
	now := time.Now().UnixMilli()

	for subject, st := range stats {
		segments := strings.Split(subject, ".")
		current := rootChildren

		for i, seg := range segments {
			fullSubject := strings.Join(segments[:i+1], ".")
			node, ok := current[seg]
			if !ok {
				node = &treeNode{
					segment:     seg,
					fullSubject: fullSubject,
					children:    make(map[string]*treeNode),
				}
				current[seg] = node
			}

			if i == len(segments)-1 {
				node.messageCount = st.MessageCount
				node.lastMessage = st.LastMessage
				count := 0
				cutoff := now - 10000
				for _, t := range st.Timestamps {
					if t >= cutoff {
						count++
					}
				}
				node.rate = float64(count) / 10.0
			}

			current = node.children
		}
	}

	var convert func(children map[string]*treeNode) []SubjectNode
	convert = func(children map[string]*treeNode) []SubjectNode {
		if len(children) == 0 {
			return []SubjectNode{}
		}
		result := make([]SubjectNode, 0, len(children))
		for _, n := range children {
			sn := SubjectNode{
				Segment:      n.segment,
				FullSubject:  n.fullSubject,
				MessageCount: n.messageCount,
				LastMessage:  n.lastMessage,
				Children:     convert(n.children),
				Rate:         n.rate,
			}
			result = append(result, sn)
		}
		sort.Slice(result, func(i, j int) bool {
			return result[i].Segment < result[j].Segment
		})
		return result
	}

	return convert(rootChildren)
}
