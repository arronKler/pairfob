package runtime

// Machine is another computer this runtime can already reach over SSH. Target
// is the operator's own SSH destination and stays on this computer: it is
// never sent to a paired device.
type Machine struct {
	ID      string
	Label   string
	Target  string
	Session string
	Enabled bool
}

type MachineListQuery struct{}

func (MachineListQuery) runtimeQuery() {}

type MachineListView struct{ Machines []Machine }

func (MachineListView) runtimeView() {}
