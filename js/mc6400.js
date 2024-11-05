/* Philips ComputerLab MC6400 Emulator
 * 
 * MC6400 board hardware emulation and GUI interface.
 *
 * https://github.com/ThorstenBr/MasterLab-MC6400
 * 
 * Copyright 2024 Thorsten Brehm, brehmt (at) gmail com
 */

var GUI_F1           = gui("F1");
var GUI_F2           = gui("F2");
var GUI_F3           = gui("F3");
var GUI_POWER        = gui("POWER");
var GUI_SSD_LED      = gui("SSD_LED");
var BUTTON_CPU_START = gui("CPU_START");
var BUTTON_CPU_HALT  = gui("CPU_HALT");
var BUTTON_CPU_STEP  = gui("CPU_STEP");

/* ***********************************************/
/* Hardware emulation registers                  */
var PowerState = true;  // state of power supply
var ButtonMatrix = [0,0,0,0,0,0,0,0]; // state of the button matrix
var MatrixBitmask = 0; // button and segment matrix selection bitmask
/* ***********************************************/

/* ***********************************************/
/* MC6400 I/O hardware interface
 * 
 * 7-segment #3 is manually switched between the LED array and
 * the 7-segment element. Other segments are not switched.
 * 
 * WRITE REGISTERS:
 *   FD0x: Matrix selection bitmask.
 *         bit n: selects 7-segment #n for output
 *         bit n: also selects button matrix row #n for input
 * 
 *   FD1x: Writes segment/LED bitmask for selected segment
 * 
 * READ REGISTERS:
 *   FD0x: Reads flags for selected button matrix row.
 *           bit 0: green alpha-numeric key 0-7 pressed
 *           bit 1: green alpha-numeric key 8..F pressed
 *           bit 2: blue function key pressed
 *         To determine the button value, consider the selected row.
 *         For the alpha-numeric key the row number matches the natural
 *         button value (selected row 0..7 matches key 0..7 or 8..F).
 *         For the blue function keys, the row number matches the
 *         buttons when numbered top to bottomm, left column first,
 *         second column last:
 *         A-D=0, RUN=1, ME-=2, ME+=3, SV=4, LD=5, CPU=6, SP=7
 *
 * ***********************************************/

/* I/O write operation. Called from CPU emulator. */
function io_write(adr, value)
{
	value = w8(value);
	if ((adr&0xFFF0) == 0xFD00)
	{
		// register
		MatrixBitmask = value;
	}
	else
	if ((adr&0xFFF0) == 0xFD10)
	{
		for (var i=0;i<8;i++)
		{
			if (MatrixBitmask & (1<<i))
			{
				show_7segment(i, value);
			}
		}
	}
}

/* I/O read operation. Called from CPU emulator. */
function io_read(adr)
{
	if ((adr & 0xFFF0) == 0xFD00)
	{
		//console.log("reading buttons at", hex(adr), hex16(R_PC));
		for (var i=0;i<8;i++)
		{
			if (MatrixBitmask & (1<<i))
			{
				return ButtonMatrix[i] ^ 0xFF;
			}
		}
		return 0xFF;
	}
}

var last_led_state = 0;

/* Update the F1-F3 output LEDs */
function update_output_leds()
{
	// mask F1-F3 in status register
	var new_led_state = R_S & 0xE;
	if (last_led_state == new_led_state)
		return;
	last_led_state = new_led_state;
	GUI_F1.checked       = ((R_S & 2) != 0);
	GUI_F2.checked       = ((R_S & 4) != 0);
	GUI_F3.checked       = ((R_S & 8) != 0);
}

var CpuTimer = null;
var LastDigitsClearedMs = 0;

function cpu_go()
{
	var tMs = performance.now();
	if (tMs - LastDigitsClearedMs > 10)
	{
		clear_digits();
		LastDigitsClearedMs = tMs;
	}

	if ((!Halted)&&(PowerState))
		cpu_run(1000);

	if ((Halted)||(!PowerState))
	{
		CpuTimer = null;
		clear_digits();
		clear_digits(3);
		cpu_show();
	}
	else
		CpuTimer = setTimeout(cpu_go, 3);
}

/* Halt the CPU execution */
function cpu_halt(id)
{
	Halted = true;

	BUTTON_CPU_START.disabled    = false;
	BUTTON_CPU_START.style.color = "black";
	BUTTON_CPU_HALT.disabled     = true;
	BUTTON_CPU_HALT.style.color = "red";
}

/* Execute a single CPU instruction.
 * Single-step mode only. */
function cpu_single_step(id)
{
	cpu_halt();
	if (CpuTimer != null)
	{
		// The CPU is still in running mode when the timer exists.
		return;
	}
	if (!PowerState)
		return;
	cpu_step();
}

/* Halt the CPU execution */
function cpu_start(id)
{
	// already started?
	if (CpuTimer != null)
		return;

	// update GUI buttons
	BUTTON_CPU_START.style.color = "red";
	BUTTON_CPU_HALT.style.color  = "black";
	BUTTON_CPU_START.disabled    = true;
	BUTTON_CPU_HALT.disabled     = false;

	Halted = false;
	CpuTimer = setTimeout(cpu_go, 10);
}

/* request the system to power off */
function power_off()
{
	change_power_state(false);
}

/* change system power state */
function change_power_state(state)
{
	PowerState = state;
	if ((!PowerState)&&(CpuTimer != null))
	{
		Halted = true;
		if (CpuTimer != null)
		{
			// CPU is still running: check again after some delay
			setTimeout(power_off, 20);
			return;
		}
	}

	if (!PowerState)
	{
		// memory/CPU state lost when power is off
		memory_init(false);
		cpu_reset();
		clear_digits();
	}
	else
	{
		if (!BUTTON_CPU_HALT.disabled)
			cpu_start();
	}
}

function power_toggle(id)
{
	// power state animation is inverted...
	change_power_state(!GUI_POWER.checked);
	clear_digits();
}

function ssdled_toggle()
{
	led_selected = !GUI_SSD_LED.checked;
	clear_digits(3);
}

function sensor_input(key, down)
{
	var SV = 0;

	if (key == "SA") SV = 0x10;
	else
	if (key == "SB") SV = 0x20;
	else
		return;

	if (down)
	{
		SensorsSet |= SV;
	}
	else
	{
		SensorsCleared |= SV;
	}
	//console.log("sensor_input: ", SensorsSet, SensorsCleared);
}

/* input handler for green alphanumeric and blue function keys */
function button_matrix_input(key, down)
{
	var idx  = key & 0x7;
	var flag = key >> 4;

	if (down)
		ButtonMatrix[idx] |= flag;
	else
		ButtonMatrix[idx] &= 0xff ^ flag;
	//console.log("button_matrix_input: ", key, down, idx, ButtonMatrix[idx]);
}

function green_button_init()
{
	// connect green alphanumeric buttons
	const buttons = gui("ALPHANUMKEYS");
	var row_key = 12;
	var skip = false;
	for (let row of buttons.rows)
	{
		skip = !skip;
		if (skip)
			continue;
		key = row_key;
		row_key -= 4;
		for (let cell of row.cells)
		{
			var flag = (key>=8) ? 0x2 : 0x1; // alphanum key 0x2=8..F, 0x1=0..7
			cell.userdata = (key&7) | (flag << 4);
			cell.onmousedown = function() {button_matrix_input(cell.userdata, true);};
			cell.onmouseup   = function() {button_matrix_input(cell.userdata, false);};

			// touch events
			cell.addEventListener("touchstart", (event) => {
					button_matrix_input(cell.userdata, true);
					event.preventDefault();}, false);
			cell.addEventListener("touchend", (event) => {
					button_matrix_input(cell.userdata, false);
					event.preventDefault();}, false);
			key++;
		}
	}
}

function blue_button_init()
{
	// connect blue control buttons
	const buttons = gui("FUNCTIONKEYS");
	var skip = false;
	var button_row = 0;
	for (let row of buttons.rows)
	{
		skip = !skip;
		// skip the odd lines with the button labels
		if (skip)
			continue;
		var button_column = 0;
		var flag = 4; // flag value when any function key is pressed
		for (let cell of row.cells)
		{
			// blue buttons are numbered top to bottom, left to right
			cell.userdata = (button_row + button_column*4) | (flag << 4);
			cell.onmousedown = function() {button_matrix_input(cell.userdata, true); };
			cell.onmouseup   = function() {button_matrix_input(cell.userdata, false);};

			// touch events
			cell.addEventListener("touchstart", (event) => {
					button_matrix_input(cell.userdata, true);
					event.preventDefault();}, false);
			cell.addEventListener("touchend", (event) => {
					button_matrix_input(cell.userdata, false);
					event.preventDefault();}, false);

			button_column++;
		}
		button_row++;
	}
}

/* MC6400 board hardware initialization */
function mc6400_init()
{
	disassemler_init();

	gui("RESET").onclick  = cpu_reset;

	gui("SA").onmousedown = function() { sensor_input("SA", true);}
	gui("SB").onmousedown = function() { sensor_input("SB", true);}
	gui("SA").onmouseup   = function() { sensor_input("SA", false);}
	gui("SB").onmouseup   = function() { sensor_input("SB", false);}

	// touch events
	gui("SA").addEventListener("touchstart", (event) => {
					sensor_input("SA", true);
					event.preventDefault();}, false);
	gui("SA").addEventListener("touchend", (event) => {
					sensor_input("SA", false);
					event.preventDefault();}, false);
	gui("SB").addEventListener("touchstart", (event) => {
					sensor_input("SB", true);
					event.preventDefault();}, false);
	gui("SB").addEventListener("touchend", (event) => {
					sensor_input("SB", false);
					event.preventDefault();}, false);

	GUI_POWER.onchange          = power_toggle;
	GUI_SSD_LED.onchange        = ssdled_toggle;
	ssdled_toggle();

	BUTTON_CPU_START.onclick = cpu_start;
	BUTTON_CPU_HALT.onclick  = cpu_halt;
	BUTTON_CPU_STEP.onclick  = cpu_single_step;

	green_button_init();
	blue_button_init();

	// load MC6400 EPROM into ROM area at 0x0000-0x0FFF
	load_program(0x0, MC6400_ROM);

	cpu_reset();
	power_toggle();
}

// initialize the board
mc6400_init();
