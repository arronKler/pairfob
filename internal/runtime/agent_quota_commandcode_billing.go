package runtime

import (
	"context"
	"net/http"
	"time"
)

// Organisation discovery stays serial. The two independently scoped billing
// reads overlap; only the result that decides the account may publish its
// Retry-After/forbidden metadata, regardless of completion order.
func readCommandCodeBilling(parent context.Context, c *http.Client, headers map[string]string, query string, now time.Time) QuotaAccount {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	type planResult struct {
		subscription commandCodeSubscription
		status       string
		note         *quotaNote
	}
	plans := make(chan planResult, 1)
	go func() {
		result := planResult{note: &quotaNote{}}
		planCtx := context.WithValue(ctx, quotaNoteKey{}, result.note)
		result.status = quotaJSON(planCtx, c, commandCodeAPIURL+"/alpha/billing/subscriptions"+query, headers, nil, &result.subscription)
		plans <- result
	}()
	creditsNote := &quotaNote{}
	creditsCtx := context.WithValue(ctx, quotaNoteKey{}, creditsNote)
	var credits commandCodeCredits
	if status := quotaJSON(creditsCtx, c, commandCodeAPIURL+"/alpha/billing/credits"+query, headers, nil, &credits); status != "" {
		copyCommandCodeNote(parent, creditsNote)
		return quotaAccount(emptyQuota("command-code", "api", status))
	}
	var plan string
	var periodEnd int64
	result := <-plans
	switch result.status {
	case "":
		if result.subscription.Data != nil {
			plan = commandCodePlan(result.subscription.Data.PlanID)
			periodEnd = result.subscription.Data.CurrentPeriodEnd.unix()
		}
	case "auth_required", "throttled":
		copyCommandCodeNote(parent, result.note)
		return quotaAccount(emptyQuota("command-code", "api", result.status))
	}

	return parseCommandCodeQuota(credits, plan, periodEnd, now)
}

func copyCommandCodeNote(ctx context.Context, source *quotaNote) {
	target, ok := ctx.Value(quotaNoteKey{}).(*quotaNote)
	if !ok {
		return
	}
	source.mu.Lock()
	retryAt, forbidden := source.retryAt, source.forbidden
	source.mu.Unlock()
	target.mu.Lock()
	target.retryAt = max(target.retryAt, retryAt)
	target.forbidden = target.forbidden || forbidden
	target.mu.Unlock()
}
