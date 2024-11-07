/* INS8070 disassembler and CPU monitor.
 * 
 * Based on:
 *  - INS8070 data sheet
 *
 * https://github.com/ThorstenBr/MasterLab-MC6400
 * 
 * Copyright 2024 Thorsten Brehm, brehmt (at) gmail com
 */

var GUI_EA           = gui("R_EA");
var GUI_T            = gui("R_T");
var GUI_S            = gui("R_S");
var GUI_FLAGS        = gui("FLAGS");
var GUI_PC           = gui("R_PC");
var GUI_SP           = gui("R_SP");
var GUI_P2           = gui("R_P2");
var GUI_P3           = gui("R_P3");
var GUI_CYCLES       = gui("CPU_CYCLES");
var GUI_INSTRUCTION  = gui("INSTRUCTION");
var GUI_OPCODE       = gui("OPCODE");
var GUI_MEMORY       = gui("MEMORY");
var GUI_DISASSEMBLER = gui("DISASSEMBLER");
var GUI_MEMADDRESS   = gui("ADDRESS");
var GUI_DISADDRESS   = gui("DIS_ADDRESS");
var GUI_BPADDRESS    = gui("BREAKPOINT");

var MemViewerAddress    = -4; // -4=SP
var DisassemblerAddress = -1; // -1=PC

/* special address handling:
 * -1=PC, -2=P2, -3=P3, -4=SP, -5=EA, -6=T */
function specialAddress(Address)
{
	if (Address >= 0)
		return Address;
	if (Address == -1)
		return R_PC;
	if (Address == -2)
		return R_P2;
	if (Address == -3)
		return R_P3;
	if (Address == -4)
		return R_SP;
	if (Address == -5)
		return R_EA;
	if (Address == -6)
		return R_T;
}

function parseAddress(v)
{
	if (v == "PC")
		return -1;
	if (v == "P2")
		return -2;
	if (v == "P3")
		return -3;
	if (v == "SP")
		return -4;
	if (v == "EA")
		return -5;
	if (v == "T")
		return -6;

	return Number("0x"+v);
}

var InstructionBytes = 1;

function getInstruction(adr, with_machine_code)
{
	if (!PowerState)
		return InvalidInstruction;
	var b = mr8(adr, false);
	var s = InstructionSet[b];
	var mcode = hex8(b)+" ";
	var IsInvalid = (s=="");
	if (IsInvalid)
		s = "? "+hex8(b) +" ?";
	InstructionBytes = 1;
	if (s.indexOf("YY") > 0)
	{
		var Addr = mr16(adr+1,false);
		mcode += hex8(Addr & 0xff)+" "+hex8(Addr >> 8)+" ";
		/* The CPU has the funny quirk that JMP/JSR needs to specify target address-1.
		 * We show the actual target address - not the byte encoded in machine code.
		 */
		if ((s=="JMP XXYY")||(s=="JSR XXYY"))
			Addr+=1;
		s = s.replace("XXYY", hex16(Addr));
		InstructionBytes = 3;
	}
	else
	if (s.indexOf("XX") > 0)
	{
		mcode += hex8(mr8(adr+1,false))+" ";
		if (s.startsWith("B")) // "B"ranch instruction?
		{
			// show negative relative addresses for branch instructions
			var Addr = mri8(adr+1,false);
			if (s.indexOf(",") < 0)
			{
				// "normal" branch, relative to PC. Show absolute address instead.
				Addr += adr+2;
				s = s.replace("XX", hex16(Addr));
			}
			else
			{
				// branch relative to some other register (P2, P3, ...): show relative displacement only
				s = s.replace("XX", hexi8(Addr));
			}
		}
		else
		if (s.endsWith(",XX"))
		{
			// direct addressing to $FFxx address range
			var Addr = mr8(adr+1,false);
			s = s.replace("XX", "FF"+hex8(Addr));
		}
		else
		{
			var Addr = mr8(adr+1,false);
			s = s.replace("XX", hex8(Addr));
		}
		InstructionBytes = 2;
	}
	var l = s.length;
	while (l < 14)
	{
		s += "&nbsp;";
		l++;
	}
	if (!with_machine_code)
		mcode = "";
	else
	{
		l = mcode.length;
		while (l < 8)
		{
			mcode += "&nbsp;"
			l++;
		}
		mcode = "<font color=\"darkseagreen\">"+mcode+"   </font> ";
	}
	if (IsInvalid)
		s = "<i><font color=\"gray\">"+s+"</font>";
	return mcode + s;
}

var InvalidInstruction = "";
for (var k=0;k<20;k++)
	InvalidInstruction += "&nbsp;";

function disassemble(Address, LineCount)
{
	var s = "";
	for (var i=0;i<LineCount;i++)
	{
		s += "<font color=\"#404040\">"+hex16(Address)+":&nbsp;</font>";
		if (!PowerState)
			s += InvalidInstruction+"<br>";
		else
		if (Address == R_PC)
			s += "<font color=\"red\">"+getInstruction(Address, true)+"</font><br>";
		else
			s += getInstruction(Address, true)+"<br>";
		Address = w16(Address + InstructionBytes);
	}
	return s;
}

function show_disassembler()
{
	var Address = specialAddress(DisassemblerAddress);
	var s = disassemble(Address, 12);
	GUI_DISASSEMBLER.innerHTML = s;
}

function getStatusFlags()
{
	var Flags = "";
	if (R_S & 0x80)
		Flags += "CY/L ";
	if (R_S & 0x40)
		Flags += "OV ";
	if (R_S & 0x20)
		Flags += "SB ";
	if (R_S & 0x10)
		Flags += "SA ";
	if (R_S & 0x08)
		Flags += "F3 ";
	if (R_S & 0x04)
		Flags += "F2 ";
	if (R_S & 0x02)
		Flags += "F1 ";
	if (R_S & 0x01)
		Flags += "IE";
	if (Flags == "")
		return "-";
	return Flags;
}

function show_memory()
{
	var Data = "";
	var Address = specialAddress(MemViewerAddress);
	for (var i=0;i<64+8*4;i++)
	{
		if ((i&7)==0)
		{
			Data += "<font color=\"#404040\">"+hex16(Address)+":&nbsp;</font>";
		}
		if (!PowerState)
			Data += ".&nbsp;&nbsp;";
		else
		if ((Address < 0x1400)||(Address >= 0xFFC0))
			Data += hex8(mr8(Address,false)) +"&nbsp;";
		else
			Data += "--&nbsp;";

		if ((i&7)==7)
			Data += "<br>\n";

		Address = w16(Address+1);
	}
	GUI_MEMORY.innerHTML = Data;
}

var CpuLastShownMs = -10000;

function cpu_show()
{
	var tMs = performance.now();

	if ((!Halted)&&(tMs-CpuLastShownMs < 500))
		return;

	CpuLastShownMs = tMs;

	show_memory();
	show_disassembler();
	update_output_leds();

	GUI_INSTRUCTION.innerHTML = getInstruction(R_PC, false);

	if (!PowerState)
	{
		GUI_EA.innerHTML     = "-";
		GUI_T.innerHTML      = "-";
		GUI_S.innerHTML      = "-";
		GUI_PC.innerHTML     = "-";
		GUI_SP.innerHTML     = "-";
		GUI_P2.innerHTML     = "-";
		GUI_P3.innerHTML     = "-";
		GUI_CYCLES.innerHTML = "-";
		GUI_FLAGS.innerHTML  = "";
		GUI_OPCODE.innerHTML = "-";
	}
	else
	{
		GUI_EA.innerHTML     = hex16(R_EA);
		GUI_T.innerHTML      = hex16(R_T);
		GUI_S.innerHTML      = hex8(R_S);
		GUI_FLAGS.innerHTML  = getStatusFlags();
		GUI_PC.innerHTML     = hex16(R_PC);
		GUI_SP.innerHTML     = hex16(R_SP);
		GUI_P2.innerHTML     = hex16(R_P2);
		GUI_P3.innerHTML     = hex16(R_P3);
		GUI_CYCLES.innerHTML = hex(Cycles);
		GUI_OPCODE.innerHTML = hex8(mr8(R_PC,false));
	}
}

function memory_address_change(id)
{
	var o = GUI_MEMADDRESS.value;
	var s = o.toUpperCase();
	if (s != o)
		GUI_MEMADDRESS.value = s;
	var v = parseAddress(s);
	if (!isNaN(v))
		MemViewerAddress = v;
	show_memory();
}

function disassembler_address_change(id)
{
	var o = GUI_DISADDRESS.value;
	var s = o.toUpperCase();
	if (s != o)
		GUI_DISADDRESS.value = s;
	var v = parseAddress(s);
	if (!isNaN(v))
		DisassemblerAddress = v;
	show_disassembler();
}

/* set/update CPU breakpoint address */
function breakpoint_address_change(id)
{
	var o = GUI_BPADDRESS.value;
	var s = o.toUpperCase();
	if (s != o)
		GUI_BPADDRESS.value = s;
	var v = Number("0x"+s);
	if (isNaN(v))
	{
		// disable the breakpoint
		GUI_BPADDRESS.value = "";
		BreakPoint_PC = -1;
	}
	else
	{
		BreakPoint_PC = v;
	}
}

function disassemler_init()
{
	GUI_MEMADDRESS.onchange = memory_address_change;
	GUI_DISADDRESS.onchange = disassembler_address_change;
	GUI_BPADDRESS.onchange  = breakpoint_address_change;
}
