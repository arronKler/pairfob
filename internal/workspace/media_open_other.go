//go:build !unix

package workspace

func openNoFollowNonblock() int { return 0 }
