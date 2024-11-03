/* INS8070 CPU Emulator.
 *
 * Emulates an National Semiconducter INS8070 micro controller.
 * 
 * Based on:
 *  - INS8070 data sheet
 *  - extensive documentation on the lab and CPU by Norbert Schneider
 *  - Philips MC6400 "Microcomputer Master Lab" manual.
 *
 * https://github.com/ThorstenBr/MasterLab-MC6400
 *  
 * Copyright 2024 Thorsten Brehm, brehmt (at) gmail com
 */

/* ***********************************************/
/* CPU registers                                 */
var R_EA = 0; // EA register, 16bit
var R_T  = 0; // temporary register, 16bit
var R_S  = 0; // status register, 8bit
              // bit:   7   6  5  4  3  2  1  0
              // name: CY/L OV SB SA F3 F2 F1 IE
var R_PC = 1; // program counter, 16bit
var R_SP = 0; // stack pointer, 16bit
var R_P2 = 0; // P2, 16bit
var R_P3 = 0; // P3, 16bit
/* ***********************************************/

var Cycles = 0;  // CPU cycles
var Memory = []; // Main memory

var Halted     = false; // CPU running vs halted

// sensor states (SA,SB). We set/clear the flags only in between cycles, so we can single step
var SensorsSet = 0;
var SensorsCleared = 0;
var BreakPoint_PC = -1; // disabled

function cpu_debug()
{
	console.log("EA: ", R_EA);
	console.log("T:  ", R_T);
	console.log("S:  ", R_S);
	console.log("SP: ", R_SP);
	console.log("P2: ", R_P2);
	console.log("P3: ", R_P3);
	console.log("PC: ", R_PC);
	console.log("OPC: ", Memory[R_PC]);
	console.log("Halted: ", Halted);
	console.log("------------------\n");
}

// load program or ROM data (also writes to ROM)
function load_program(address, program)
{
	for (var i=0;i<0x1000;i++) // 4KB ROM max
	{
		var v = program[i];
		if (v === undefined)
			return;
		if (address < 0x1400)
			Memory[address+i] = v;
	}
}

// Set status register.
// Sensor A/B flags cannot be written and are protected.
function set_S(v)
{
	R_S = (R_S & 0x30) | (v & 0xBF); // keep SA/SB
}

// set or reset CarrY/Link flag
function set_CYL(v)
{
	if (v != 0)
		v = 0x80;
	R_S = (R_S & 0x7F) | v;
}

// set accumulator, lower 8 bit in R_EA (preserving the E in the upper 8bit)
function set_A(v)
{
	R_EA = (R_EA & 0xFF00) | w8(v);
}

// 16bit wrap
function w16(v) { if (v<0) v+= 65536;return v & 0xffff; }

function w8(v) { if (v<0) v+= 256;return v&0xff; }

// memory read, 8bit
function mr8(adr)
{
	adr = w16(adr);
	if ((adr >= 0xffc0)||(adr < 0x1400))
		return Memory[adr];
	else
	if ((adr >= 0xFD00)&&(adr < 0xFDFF))
	{
		return io_read(adr);
	}
	else
	{
		console.log("IGNORED READ:", hex(adr));
		return Memory[adr];
	}
}

// memory read, 8bit, integer/signed
// used for relative/displacement offsets
function mri8(adr)
{
	adr = w16(adr);
	var v = Memory[adr];
	if (v<0x80)
		return v;
	return v-256;
}

// memory read, 16bit
function mr16(adr) { return (Memory[(adr+1)&0xffff] << 8) | Memory[adr&0xffff]; }

// memory write, 8 bit
function mw8(adr,v)
{
	if ((adr >= 0xffc0)||((adr>=0x1000)&&(adr < 0x1400))) // 2K external RAM, 64byte internal RAM
		Memory[adr & 0xffff] = v & 0xff;
	else
	if ((adr >= 0xFD00)&&(adr < 0xFDFF))
	{
		io_write(adr, v);
	}
	else
	{
		console.log("IGNORED WRITE:", hex(adr), hex(v));
	}
}

// memory write, 16bit
function mw16(adr,v) { mw8(adr,v);mw8(adr+1,v>>8); }

/* initialize memory.
 *  clear_rom: false = RAM only, true = entire address space. */
function memory_init(clear_rom)
{
	if (clear_rom)
	{
		// clear entire address space
		for (var i=0;i<65536;i++)
			Memory[i] = 0;
	}
	else
	{
		// clear RAM only
		for (var adr=0x1000;adr<0x1400;adr++)
			Memory[adr] = 0;
		for (var adr=0xFFC0;adr<=0xFFFF;adr++)
			Memory[adr] = 0;
	}
}

function cpu_run(steps)
{
	while (PowerState && !Halted)
	{
		cpu_step();
		if (--steps == 0)
			break;
	}
}

function cpu_reset()
{
	R_PC = 0x1;
	R_S  = 0x0;
	R_SP = 0x0;
	cpu_show();
}

function isNotDigit()
{
	// check if A is NOT a digit (not in 0x30h...0x39)
	var A = R_EA & 0xFF;
	return (A<0x30)||(A>0x39);
}

function isCYL() // CY/L bit in status register
{
	return (R_S >> 7);
}

/* CPU operations */
function opCALL(adr)
{
	R_SP = w16(R_SP-2);
	mw16(R_SP, R_PC);
	R_PC = mr16(adr);
	Cycles += 17;
}

function opPUSH16(adr)
{
	R_SP = w16(R_SP-2);
	mw16(R_SP, adr);
	Cycles += 8;
}

function opPOP16()
{
	var v = mr16(R_SP);
	R_SP = w16(R_SP+2);
	Cycles += 9;
	return v;
}

function opBRANCH(Condition, Base)
{
	R_PC += 1;
	if (Condition)
		R_PC = Base + mri8(R_PC);

	Cycles += 5;
}

function opADD8(v1, v2)
{
	v1 = w8(v1);
	v2 = w8(v2);
	var v = v1+v2;
	var Carry = (v >= 0x100) ? 0x80 : 0x00;
	if (Carry)
		R_S |= 0x80;
	else
		R_S &= 0x7F;
	var Overflow = ((v1 & 0x7f) + (v2 & 0x7f)) & 0x80;
	if (Carry != Overflow)
		R_S |= 0x40;
	else
		R_S &= 0xBF;
	return w8(v);
}

function opADD16(v1, v2)
{
	v1 = w16(v1);
	v2 = w16(v2);
	var v = v1+v2;
	var Carry = (v >= 0x10000) ? 0x80 : 0x00;
	if (Carry)
		R_S |= 0x80;
	else
		R_S &= 0x7F;
	var Overflow = ((v1 & 0x7fff) + (v2 & 0x7fff)) & 0x80;
	if (Carry != Overflow)
		R_S |= 0x40;
	else
		R_S &= 0xBF;
	return w16(v);
}

function opSUB8(v1, v2)
{
	v1 = w8(v1);
	v2 = w8(v2);
	var v = 0x100+v1-v2;
	var Carry = (v >= 0x100) ? 0x80 : 0x00;
	if (Carry)
		R_S |= 0x80;
	else
		R_S &= 0x7F;
	//TODO check overflow logic
	var Overflow = (0x100 + (v1 & 0x7f) - (v2 & 0x7f)) & 0x80;
	if (Carry != Overflow)
		R_S |= 0x40;
	else
		R_S &= 0xBF;
	return w8(v);
}

function opSUB16(v1, v2)
{
	v1 = w16(v1);
	v2 = w16(v2);
	var v = 0x10000+v1-v2;
	var Carry = (v >= 0x10000) ? 0x80 : 0x00;
	if (Carry)
		R_S |= 0x80;
	else
		R_S &= 0x7F;
	//TODO check overflow logic
	var Overflow = (0x10000 + (v1 & 0x7f) - (v2 & 0x7f)) & 0x80;
	if (Carry != Overflow)
		R_S |= 0x40;
	else
		R_S &= 0xBF;
	return w16(v);
}

// decrement and load
function opDLD(adr)
{
	var v = w8(mr8(adr)-1);
	mw8(adr, v);
	set_A(v);
}

// increment and load
function opILD(adr)
{
	var v = w8(mr8(adr)+1);
	mw8(adr, v);
	set_A(v);
}

/* "search and skip if character matched" instruction.
 * One of the weirdest CPU instructions I have ever seen, not matching
 * the rest of the instruction sets concept.
 * Data sheet isn't even able to specify the clock cycles consumed by
 * this one... */
function opSSM(address)
{
	var A = R_EA & 0xFF;
	// not sure how many CPU cycles this instruction really needed
	Cycles += 3;
	for (var i=0;i<256;i++)
	{
		Cycles += 2; // approximation...
		if (mr8(address) == A)
		{
			// execution skips two bytes ahead when a match was found
			R_PC += 2;
			return address;
		}
		address += 1;
	}
	// execution continues with next instruction, when not found
	return w16(address);
}

function cpu_step()
{
	if (!PowerState)
		return;

	// set input sensors in R_S (SA or SB)
	if (SensorsSet != 0)
	{
		R_S |= SensorsSet;
		SensorsSet = 0;
	}

	switch(Memory[R_PC])
	{
		case 0x06: // LD A,S 	06 	3 	  	implicit 	A:=(S)
			set_A(R_S);
			Cycles += 3;
			break;

		case 0x07: // LD S,A 	07 	3 	*** 	implicit 	S:=(A)
			set_S(R_EA & 0xFF);
			Cycles += 3;
			break;

		case 0x09: // LD T,EA 	09 	4 	  	implicit 	T:=(EA)
			R_T = R_EA;
			Cycles += 4;
			break;

		case 0x0B: // LD EA,T 	0B 	4 	  	implicit 	EA:=(T)
			R_EA = R_T;
			Cycles += 4;
			break;

		case 0x25: // LD SP,=XXYY 	25 YY XX 	8 	  	immediate 	SP:=XXYY
			R_SP = mr16(R_PC+1);
			R_PC += 2;
			Cycles += 8;
			break;

		case 0x26: // LD P2,=XXYY 	26 YY XX 	8 	  	immediate 	P2:=XXYY
			R_P2 = mr16(R_PC+1);
			R_PC += 2;
			Cycles += 8;
			break;

		case 0x27: // LD P3,=XXYY 	27 YY XX 	8 	  	immediate 	P3:=XXYY
			R_P3 = mr16(R_PC+1);
			R_PC += 2;
			Cycles += 8;
			break;

		case 0x30: // LD EA,PC 	30 	4 	  	implicit 	EA:=(PC)
			R_EA = R_PC;
			Cycles += 4;
			break;

		case 0x31: // LD EA,SP 	31 	4 	  	implicit 	EA:=(SP)
			R_EA = R_SP;
			Cycles += 4;
			break;

		case 0x32: // LD EA,P2 	32 	4 	  	implicit 	EA:=(P2)
			R_EA = R_P2;
			Cycles += 4;
			break;

		case 0x33: // LD EA,P3 	32 	4 	  	implicit 	EA:=(P3)
			R_EA = R_P3;
			Cycles += 4;
			break;

		case 0x40: // LD A,E 	40 	4 	  	implicit 	A:=(E)
			set_A(R_EA >> 8);
			Cycles += 4;
			break;

		case 0x44: // LD PC,EA 	44 	5 	  	implicit 	PC:=(EA)
			R_PC = R_EA;
			Cycles += 5;
			break;

		case 0x45: // LD SP,EA 	45 	5 	  	implicit 	SP:=(EA)
			R_SP = R_EA;
			Cycles += 5;
			break;

		case 0x46: // LD P2,EA 	46 	5 	  	implicit 	P2:=(EA)
			R_P2 = R_EA;
			Cycles += 5;
			break;

		case 0x47: // LD P3,EA 	47 	5 	  	implicit 	P3:=(EA)
			R_P3 = R_EA;
			Cycles += 5;
			break;

		case 0x48: // LD E,A 	48 	4 	  	implicit 	E:=(A)
			R_EA = (R_EA & 0xff) | ((R_EA & 0xff)<<8);
			Cycles += 4;
			break;

		case 0x80: // LD EA,XX,PC 	80 XX 	10 	  	PC relative	EA:=((PC)+XX)
			R_PC += 1;
			R_EA = mr16(R_PC+mri8(R_PC));
			Cycles += 10;
			break;

		case 0x81: // LD EA,XX,SP 	81 XX 	10 	  	SP relative	EA:=((SP)+XX)
			R_PC += 1;
			R_EA = mr16(R_SP+mri8(R_PC));
			Cycles += 10;
			break;

		case 0x82: // LD EA,XX,P2 	82 XX 	10 	  	P2 relative	EA:=((P2)+XX)
			R_PC += 1;
			R_EA = mr16(R_P2+mri8(R_PC));
			Cycles += 10;
			break;

		case 0x83: // LD EA,XX,P3 	83 XX 	10 	  	P3 relative	EA:=((P3)+XX)
			R_PC += 1;
			R_EA = mr16(R_P3+mri8(R_PC));
			Cycles += 10;
			break;

		case 0x84: // LD EA,=XXYY 	84 YY XX 	8 	  	immediate 	EA:=XXYY
			R_EA = mr16(R_PC+1);
			R_PC += 2;
			Cycles += 8;
			break;

		case 0x85: // LD EA,XX 	85 XX 	10 	  	direct 	EA:=(FF00+XX)
			R_PC += 1;
			R_EA = mr16(0xFF00 | mr8(R_PC));
			Cycles += 10;
			break;

		case 0x86: // LD EA,@XX,P2 	86 XX 	11 	  	auto-indexed 	P2:=(P2)+XX, EA:=((P2))
		{          //                                               EA:=((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			R_EA = mr16(R_P2);
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 11;
			break;
		}

		case 0x87: // LD EA,@XX,P3 	87 XX 	11 	  	auto-indexed 	P3:=(P3)+XX, EA:=((P3))
		{          //                                               EA:=((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			R_EA = mr16(R_P3);
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 11;
			break;
		}

		case 0xA0: // LD T,XX,PC 	A0 XX 	10 	  	PC relative	T:=((PC)+XX)
			R_PC += 1;
			R_T = mr16(R_PC+mri8(R_PC));
			Cycles += 10;
			break;

		case 0xA1: // LD T,XX,SP 	A1 XX 	10 	  	SP relative	T:=((SP)+XX)
			R_PC += 1;
			R_T = mr16(R_SP+mri8(R_PC));
			Cycles += 10;
			break;

		case 0xA2: // LD T,XX,P2 	A2 XX 	10 	  	P2 relative	T:=((P2)+XX)
			R_PC += 1;
			R_T = mr16(R_P2+mri8(R_PC));
			Cycles += 10;
			break;

		case 0xA3: // LD T,XX,P3 	A3 XX 	10 	  	P3 relative	T:=((P3)+XX)
			R_PC += 1;
			R_T = mr16(R_P3+mri8(R_PC));
			Cycles += 10;
			break;

		case 0xA4: // LD T,=XXYY 	A4 YY XX 	8 	  	immediate 	T:=XXYY
			R_T = mr16(R_PC+1);
			R_PC += 2;
			Cycles += 8;
			break;

		case 0xA5: // LD T,XX 	A5 XX 	10 	  	direct 	T:=(FF00+XX)
			R_PC += 1;
			R_T = mr16(0xFF00 | mr8(R_PC));
			Cycles += 10;
			break;

		case 0xA6: // LD T,@XX,P2 	A6 XX 	11 	  	auto-indexed 	P2:=(P2)+XX, T:=((P2))
		{          //                                               T:=((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			R_T = mr16(R_P2);
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 11;
			break;
		}

		case 0xA7: // LD T,@XX,P3 	A7 XX 	11 	  	auto-indexed 	P3:=(P3)+XX, T:=((P3))
		{          //                                               T:=((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			R_T = mr16(R_P3);
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 11;
			break;
		}

		case 0xC0: // LD A,XX,PC 	C0 XX 	7 	  	PC relative	A:=((PC)+XX)
			R_PC += 1;
			set_A(mr8(R_PC + mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xC1: // LD A,XX,SP 	C1 XX 	7 	  	SP relative	A:=((SP)+XX)
			R_PC += 1;
			set_A(mr8(R_SP + mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xC2: // LD A,XX,P2 	C2 XX 	7 	  	P2 relative	A:=((P2)+XX)
			R_PC += 1;
			set_A(mr8(R_P2 + mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xC3: // LD A,XX,P3 	C3 XX 	7 	  	P3 relative	A:=((P3)+XX)
			R_PC += 1;
			set_A(mr8(R_P3 + mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xC4: // LD A,=XX 	C4 XX 	5 	  	immediate 	A:=XX
			R_PC += 1;
			set_A(mr8(R_PC));
			Cycles += 5;
			break;

		case 0xC5: // LD A,XX 	C5 XX 	7 	  	direct 	A:=(FF00+XX)
			R_PC += 1;
			set_A(mr8(0xFF00 | mr8(R_PC)));
			Cycles += 7;
			break;

		case 0xC6: // LD A,@XX,P2 	C6 XX 	8 	  	auto-indexed 	P2:=(P2)+XX, A:=((P2))
		{          //                                               A:=((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			set_A(mr8(R_P2));
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0xC7: // LD A,@XX,P3 	C7 XX 	8 	  	auto-indexed 	P3:=(P3)+XX, A:=((P3))
		{          //                                               A:=((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			set_A(mr8(R_P3));
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0x88: // ST EA,XX,PC 	88 XX 	10 	  	PC relative	((PC)+XX):=(EA)
			R_PC += 1;
			mw16(R_PC+mri8(R_PC), R_EA);
			Cycles += 10;
			break;

		case 0x89: // ST EA,XX,SP 	89 XX 	10 	  	SP relative	((SP)+XX):=(EA)
			R_PC += 1;
			mw16(R_SP+mri8(R_PC), R_EA);
			Cycles += 10;
			break;

		case 0x8A: // ST EA,XX,P2 	8A XX 	10 	  	P2 relative	((P2)+XX):=(EA)
			R_PC += 1;
			mw16(R_P2+mri8(R_PC), R_EA);
			Cycles += 10;
			break;

		case 0x8B: // ST EA,XX,P3 	8B XX 	10 	  	P3 relative	((P3)+XX):=(EA)
			R_PC += 1;
			mw16(R_P3+mri8(R_PC), R_EA);
			Cycles += 10;
			break;

		case 0x8D: // ST EA,XX 	8D XX 	10 	  	direct 	(FF00+XX):=(EA)
			R_PC += 1;
			mw16(0xFF00 | mr8(R_PC), R_EA);
			Cycles += 10;
			break;

		case 0x8E: // ST EA,@XX,P2 	8E XX 	11 	  	auto-indexed 	P2:=(P2)+XX, ((P2)):=(EA)
		{          //                                               ((P2)):=(EA), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			mw16(R_P2, R_EA);
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0x8F: // ST EA,@XX,P3 	8F XX 	11 	  	auto-indexed 	P3:=(P3)+XX, ((P3)):=(EA)
		{          //                                               ((P3)):=(EA), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			mw16(R_P3, R_EA);
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0xC8: // ST A,XX,PC 	C8 XX 	7 	  	PC relative	((PC)+XX):=(A)
			R_PC += 1;
			mw8(R_PC+mri8(R_PC), R_EA);
			Cycles += 7;
			break;

		case 0xC9: // ST A,XX,SP 	C9 XX 	7 	  	SP relative	((SP)+XX):=(A)
			R_PC += 1;
			mw8(R_SP+mri8(R_PC), R_EA);
			Cycles += 7;
			break;

		case 0xCA: // ST A,XX,P2 	CA XX 	7 	  	P2 relative	((P2)+XX):=(A)
			R_PC += 1;
			mw8(R_P2+mri8(R_PC), R_EA);
			Cycles += 7;
			break;

		case 0xCB: // ST A,XX,P3 	CB XX 	7 	  	P3 relative	((P3)+XX):=(A)
			R_PC += 1;
			mw8(R_P3+mri8(R_PC), R_EA);
			Cycles += 7;
			break;

		case 0xCD: // ST A,XX 	CD XX 	7 	  	direct 	(FF00+XX):=(A)
			R_PC += 1;
			mw8(0xFF00 + mr8(R_PC), R_EA);
			Cycles += 7;
			break;

		case 0xCE: // ST A,@XX,P2 	CE XX 	8 	  	auto-indexed 	P2:=(P2)+XX, ((P2)):=(A)
		{          //                                               ((P2)):=(A), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			mw8(R_P2, R_EA);
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}
		
		case 0xCF: // ST A,@XX,P3 	CF XX 	8 	  	auto-indexed 	P3:=(P3)+XX, ((P3)):=(A)
		{          //                                               ((P3)):=(A), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			mw8(R_P3, R_EA);
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0x01: // XCH A,E 	01 	5 	  	implicit 	A<->E
			R_EA = (R_EA >> 8) | ((R_EA & 0xFF)<<8);
			Cycles += 5;
			break;

		case 0x4C: // XCH PC,EA 	4C 	7 	  	implicit 	PC<->EA
			var h = R_PC;
			R_PC = R_EA;
			R_EA = h;
			Cycles += 7;
			break;

		case 0x4D: // XCH EA,SP 	4D 	7 	  	implicit 	EA<->SP
			var h = R_SP;
			R_SP = R_EA;
			R_EA = h;
			Cycles += 7;
			break;

		case 0x4E: // XCH EA,P2 	4E 	7 	  	implicit 	EA<->P2
			var h = R_P2;
			R_P2 = R_EA;
			R_EA = h;
			Cycles += 7;
			break;

		case 0x4F: // XCH EA,P3 	4F 	7 	  	implicit 	EA<->P3
			var h = R_P3;
			R_P3 = R_EA;
			R_EA = h;
			Cycles += 7;
			break;

		case 0x70: // ADD A,E 	70 	4 	** 	implicit 	A:=(A)+(E)
			set_A(opADD8(R_EA & 0xFF, R_EA >> 8));
			Cycles += 4;
			break;

		case 0xB0: // ADD EA,XX,PC 	B0 XX 	10 	** 	PC relative	EA:=(EA)+((PC)+XX)
			R_EA = opADD16(R_EA, mr16(R_PC + mri8(R_PC+1)));
			R_PC += 1;
			Cycles += 10;
			break;

		case 0xB1: // ADD EA,XX,SP 	B1 XX 	10 	** 	SP relative	EA:=(EA)+((SP)+XX)
			R_EA = opADD16(R_EA, mr16(R_SP + mri8(R_PC+1)));
			R_PC += 1;
			Cycles += 10;
			break;

		case 0xB2: // ADD EA,XX,P2 	B2 XX 	10 	** 	P2 relative	EA:=(EA)+((P2)+XX)
			R_EA = opADD16(R_EA, mr16(R_P2 + mri8(R_PC+1)));
			R_PC += 1;
			Cycles += 10;
			break;

		case 0xB3: // ADD EA,XX,P3 	B3 XX 	10 	** 	P3 relative	EA:=(EA)+((P3)+XX)
			R_EA = opADD16(R_EA, mr16(R_P3 + mri8(R_PC+1)));
			R_PC += 1;
			Cycles += 10;
			break;

		case 0xB4: // ADD EA,=XXYY 	B4 YY XX 	10 	** 	immediate 	EA:=(EA)+XXYY
			R_EA = opADD16(R_EA, mr16(R_PC+1));
			R_PC += 2;
			Cycles += 10;
			break;

		case 0xB5: // ADD EA,XX 	B5 XX 	10 	** 	direct 	EA:=(EA)+(FF00+XX)
			R_EA = opADD16(R_EA, mr16(0xFF00 | mr8(R_PC+1)));
			R_PC += 1;
			Cycles += 10;
			break;	

		case 0xB6: // ADD EA,@XX,P2 	B6 XX 	11 	** 	auto-indexed 	P2:=(P2)+XX, EA:=(EA)+((P2))
		{          //                                                   EA:=(EA)+((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			R_EA = opADD16(R_EA, mr16(R_P2));
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0xB7: // ADD EA,@XX,P3 	B7 XX 	11 	** 	auto-indexed 	P3:=(P3)+XX, EA:=(EA)+((P3))
		{          //                                                   EA:=(EA)+((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			R_EA = opADD16(R_EA, mr16(R_P3));
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0xF0: // ADD A,XX,PC 	F0 XX 	7 	** 	PC relative	A:=(A)+((PC)+XX)
			R_PC += 1;
			// TODO check PC relative addressing
			set_A(opADD8(R_EA, mr8(R_PC + mri8(R_PC))));
			Cycles += 7;
			break;

		case 0xF1: // ADD A,XX,SP 	F1 XX 	7 	** 	SP relative	A:=(A)+((SP)+XX)
			R_PC += 1;
			set_A(opADD8(R_EA, mr8(R_SP + mri8(R_PC))));
			Cycles += 7;
			break;

		case 0xF2: // ADD A,XX,P2 	F2 XX 	7 	** 	P2 relative	A:=(A)+((P2)+XX)
			R_PC += 1;
			set_A(opADD8(R_EA, mr8(R_P2 + mri8(R_PC))));
			Cycles += 7;
			break;

		case 0xF3: // ADD A,XX,P3 	F3 XX 	7 	** 	P3 relative	A:=(A)+((P3)+XX)
			R_PC += 1;
			set_A(opADD8(R_EA, mr8(R_P3 + mri8(R_PC))));
			Cycles += 7;
			break;

		case 0xF4: // ADD A,=XX 	F4 XX 	7 	** 	immediate 	A:=(A)+XX
			R_PC += 1;
			set_A(opADD8(R_EA, mr8(R_PC)));
			Cycles += 7;
			break;

		case 0xF5: // ADD A,XX 	F5 XX 	7 	** 	direct 	A:=(A)+(FF00+XX)
			R_PC += 1;
			set_A(opADD8(R_EA, mr8(0xFF00 | mr8(R_PC))));
			Cycles += 7;
			break;

		case 0xF6: // ADD A,@XX,P2 	F6 XX 	8 	** 	auto-indexed 	P2:=(P2)+XX, A:=(A)+((P2))
		{          //                                               A:=(A)+((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			set_A(opADD8(R_EA, mr8(R_P2)));
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0xF7: // ADD A,@XX,P3 	F7 XX 	8 	** 	auto-indexed 	P3:=(P3)+XX, A:=(A)+((P3))
		{          //                                               A:=(A)+((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			set_A(opADD8(R_EA, mr8(R_P3)));
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0x78: // SUB A,E 	78 	4 	** 	implicit 	A:=(A)-(E)
			R_PC += 1;
			// TODO relative PC addressing
			set_A(opSUB8(R_EA, R_EA >> 8));
			Cycles += 4;
			break;

		case 0xB8: // SUB EA,XX,PC 	B8 XX 	10 	** 	PC relative	EA:=(EA)-((PC)+XX)
			R_PC += 1;
			// TODO relative PC addressing
			R_EA = opSUB16(R_EA, mr16(R_PC + mri8(R_PC)));
			Cycles += 10;
			break;

		case 0xB9: // SUB EA,XX,SP 	B9 XX 	10 	** 	SP relative	EA:=(EA)-((SP)+XX)
			R_PC += 1;
			R_EA = opSUB16(R_EA, mr16(R_SP + mri8(R_PC)));
			Cycles += 10;
			break;

		case 0xBA: // SUB EA,XX,P2 	BA XX 	10 	** 	P2 relative	EA:=(EA)-((P2)+XX)
			R_PC += 1;
			R_EA = opSUB16(R_EA, mr16(R_P2 + mri8(R_PC)));
			Cycles += 10;
			break;

		case 0xBB: // SUB EA,XX,P3 	BB XX 	10 	** 	P3 relative	EA:=(EA)-((P3)+XX)
			R_PC += 1;
			R_EA = opSUB16(R_EA, mr16(R_P3 + mri8(R_PC)));
			Cycles += 10;
			break;

		case 0xBC: // SUB EA,=XXYY 	BC YY XX 	10 	** 	immediate 	EA:=(EA)-XXYY
			R_PC += 1;
			R_EA = opSUB16(R_EA, mr16(R_PC));
			R_PC += 1;
			Cycles += 10;
			break;

		case 0xBD: // SUB EA,XX 	BD XX 	10 	** 	direct 	EA:=(EA)-(FF00+XX)
			R_PC += 1;
			R_EA = opSUB16(R_EA, mr16(0xFF00 | mr8(R_PC)));
			Cycles += 10;
			break;

		case 0xBE: // SUB EA,@XX,P2 	BE XX 	11 	** 	auto-indexed 	P2:=(P2)+XX, EA:=(EA)-((P2))
		{          //                                                   EA:=(EA)-((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			R_EA = opSUB16(R_EA, mr16(R_P2));
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 11;
			break;
		}

		case 0xBF: // SUB EA,@XX,P3 	BF XX 	11 	** 	auto-indexed 	P3:=(P3)+XX, EA:=(EA)-((P3))
		{          //                                                   EA:=(EA)-((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			R_EA = opSUB16(R_EA, mr16(R_P3));
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 11;
			break;
		}

		case 0xF8: // SUB A,XX,PC 	F8 XX 	7 	** 	PC relative	A:=(A)-((PC)+XX)
			R_PC += 1;
			// TODO relative PC addressing
			set_A(opSUB8(R_EA, mr8(R_PC + mri8(R_PC))));
			Cycles += 7;
			break;

		case 0xF9: // SUB A,XX,SP 	F9 XX 	7 	** 	SP relative	A:=(A)-((SP)+XX)
			R_PC += 1;
			set_A(opSUB8(R_EA, mr8(R_SP + mri8(R_PC))));
			Cycles += 7;
			break;

		case 0xFA: // SUB A,XX,P2 	FA XX 	7 	** 	P2 relative	A:=(A)-((P2)+XX)
			R_PC += 1;
			set_A(opSUB8(R_EA, mr8(R_P2 + mri8(R_PC))));
			Cycles += 7;
			break;

		case 0xFB: // SUB A,XX,P3 	FB XX 	7 	** 	P3 relative	A:=(A)-((P3)+XX)
			R_PC += 1;
			set_A(opSUB8(R_EA, mr8(R_P3 + mri8(R_PC))));
			Cycles += 7;
			break;

		case 0xFC: // SUB A,=XX 	FC XX 	7 	** 	immediate 	A:=(A)-XX
			R_PC += 1;
			set_A(opSUB8(R_EA, mr8(R_PC)));
			Cycles += 7;
			break;

		case 0xFD: // SUB A,XX 	FD XX 	7 	** 	direct 	A:=(A)-(FF00+XX)
			R_PC += 1;
			set_A(opSUB8(R_EA, mr8(0xFF00 | mr8(R_PC))));
			Cycles += 7;
			break;

		case 0xFE: // SUB A,@XX,P2 	FE XX 	8 	** 	auto-indexed 	P2:=(P2)+XX, A:=(A)-((P2))
		{          //                                               A:=(A)-((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			set_A(opSUB8(R_EA, mr8(R_P2)));
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 11;
			break;
		}

		case 0xFF: // SUB A,@XX,P3 	FF XX 	8 	** 	auto-indexed 	P3:=(P3)+XX, A:=(A)-((P3))
		{          //                                               A:=(A)-((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			set_A(opSUB8(R_EA, mr8(R_P3)));
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 11;
			break;
		}

		case 0x2C: // MPY EA,T 	2C 	37 	** 	implicit 	EA:=[(EA)*(T)]31:16,
		{          //                                   T:=[(EA)*(T)]15:0
			var m = R_EA * R_T;
			R_EA = w16(m >> 16);
			R_T  = w16(m);
			Cycles += 37;
			break;
		}

		case 0x0D: // DIV EA,T 	0D 	41 	** 	implicit 	EA:=[(EA)/(T)],
		{          //                                   T:=[(EA)%(T)]
			var d = Math.floor(R_EA / R_T);
			var r = R_EA % R_T;
			R_EA = d;
			R_T  = r;
			Cycles += 41;
			break;
		}

		case 0x90: // ILD A,XX,PC 	90 XX 	8 	  	PC relative	A:=++((PC)+XX)
			R_PC += 1;
			// TODO: relative to PC may not be correct yet
			opILD(R_PC + mri8(R_PC));
			Cycles += 8;
			break;

		case 0x91: // ILD A,XX,SP 	91 XX 	8 	  	SP relative	A:=++((SP)+XX)
			R_PC += 1;
			opILD(R_SP + mri8(R_PC));
			Cycles += 8;
			break;

		case 0x92: // ILD A,XX,P2 	92 XX 	8 	  	P2 relative	A:=++((P2)+XX)
			R_PC += 1;
			opILD(R_P2 + mri8(R_PC));
			Cycles += 8;
			break;

		case 0x93: // ILD A,XX,P3 	93 XX 	8 	  	P3 relative	A:=++((P3)+XX)
			R_PC += 1;
			opILD(R_P3 + mri8(R_PC));
			Cycles += 8;
			break;

		case 0x95: // ILD A,XX 	95 XX 	8 	  	direct 	A:=++(FF00+XX)
			R_PC += 1;
			opILD(0xFF00 | mr8(R_PC));
			Cycles += 8;
			break;

		case 0x96: // ILD A,@XX,P2 	96 XX 	9 	  	auto-indexed 	P2:=(P2)+XX, A:=++((P2))
		{          //                                               A:=++((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			opILD(R_P2);
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 9;
			break;
		}

		case 0x97: // ILD A,@XX,P3 	97 XX 	9 	  	auto-indexed 	P3:=(P3)+XX, A:=++((P3))
		{          //                                               A:=++((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			opILD(R_P3);
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 9;
			break;
		}

		case 0x98: // DLD A,XX,PC 	98 XX 	8 	  	PC relative	A:=--((PC)+XX)
			R_PC += 1;
			// TODO: relative to PC may not be correct yet
			opDLD(R_PC + mri8(R_PC));
			Cycles += 8;
			break;

		case 0x99: // DLD A,XX,SP 	99 XX 	8 	  	SP relative	A:=--((SP)+XX)
			R_PC += 1;
			opDLD(R_SP + mri8(R_PC));
			Cycles += 8;
			break;

		case 0x9A: // DLD A,XX,P2 	9A XX 	8 	  	P2 relative	A:=--((P2)+XX)
			R_PC += 1;
			opDLD(R_P2 + mri8(R_PC));
			Cycles += 8;
			break;

		case 0x9B: // DLD A,XX,P3 	9B XX 	8 	  	P3 relative	A:=--((P3)+XX)
			R_PC += 1;
			opDLD(R_P3 + mri8(R_PC));
			Cycles += 8;
			break;

		case 0x9D: // DLD A,XX 	9D XX 	8 	  	direct 	A:=--(FF00+XX)
			R_PC += 1;
			opDLD(0xFF00 | mr8(R_PC));
			Cycles += 8;
			break;

		case 0x9E: // DLD A,@XX,P2 	9E XX 	9 	  	auto-indexed 	P2:=(P2)+XX, A:=--((P2))
		{          //                                               A:=--((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			opDLD(R_P2);
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 9;
			break;
		}

		case 0x9F: // DLD A,@XX,P3 	9F XX 	9 	  	auto-indexed 	P3:=(P3)+XX, A:=--((P3))
		{          //                                               A:=--((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			opDLD(R_P3);
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 9;
			break;
		}

		case 0x39: // AND S,=XX 	39 XX 	5 	*** 	immediate 	S:=(S)&XX
			R_PC += 1;
			set_S(R_S & mr8(R_PC));
			Cycles += 5;
			break;

		case 0x50: // AND A,E 	50 	4 	  	implicit 	A:=(A)&(E)
			set_A(R_EA & (R_EA>>8));
			Cycles += 4;
			break;

		case 0xD0: // AND A,XX,PC 	D0 XX 	7 	  	PC relative	A:=(A)&((PC)+XX)
			R_PC += 1;
			set_A(R_EA & mr8(R_PC+mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xD1: // AND A,XX,SP 	D1 XX 	7 	  	SP relative	A:=(A)&((SP)+XX)
			R_PC += 1;
			set_A(R_EA & mr8(R_SP+mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xD2: // AND A,XX,P2 	D2 XX 	7 	  	P2 relative	A:=(A)&((P2)+XX)
			R_PC += 1;
			set_A(R_EA & mr8(R_P2+mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xD3: // AND A,XX,P3 	D3 XX 	7 	  	P3 relative	A:=(A)&((P3)+XX)
			R_PC += 1;
			set_A(R_EA & mr8(R_P3+mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xD4: // AND A,=XX 	D4 XX 	7 	  	immediate 	A:=(A)&XX
			R_PC += 1;
			set_A(R_EA & mr8(R_PC));
			Cycles += 7;
			break;

		case 0xD5: // AND A,XX 	D5 XX 	7 	  	direct 	A:=(A)&(FF00+XX)
			R_PC += 1;
			set_A(R_EA & mr8(0xFF00 | mri8(R_PC)));
			Cycles += 7;
			break;

		case 0xD6: // AND A,@XX,P2 	D6 XX 	8 	  	auto-indexed 	P2:=(P2)+XX, A:=(A)&((P2))
		{          //                                               A:=(A)&((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			set_A(R_EA & mr8(R_P2));
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0xD7: // AND A,@XX,P3 	D7 XX 	8 	  	auto-indexed 	P3:=(P3)+XX, A:=(A)&((P3))
		{          //                                               A:=(A)&((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			set_A(R_EA & mr8(R_P3));
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0x3B: // OR S,=XX 	3B XX 	5 	*** 	immediate 	S:=(S)|XX
			R_PC += 1;
			set_S(R_S | mr8(R_PC));
			Cycles += 5;
			break;

		case 0x58: // OR A,E 	58 	4 	  	implicit 	A:=(A)|(E)
			R_EA |= (R_EA >> 8);
			Cycles += 4;
			break;

		case 0xD8: // OR A,XX,PC 	D8 XX 	7 	  	PC relative	A:=(A)|((PC)+XX)
			R_PC += 1;
			R_EA |= mr8(R_PC+mri8(R_PC));
			Cycles += 7;
			break;

		case 0xD9: // OR A,XX,SP 	D9 XX 	7 	  	SP relative	A:=(A)|((SP)+XX)
			R_PC += 1;
			R_EA |= mr8(R_SP+mri8(R_PC));
			Cycles += 7;
			break;

		case 0xDA: // OR A,XX,P2 	DA XX 	7 	  	P2 relative	A:=(A)|((P2)+XX)
			R_PC += 1;
			R_EA |= mr8(R_P2+mri8(R_PC));
			Cycles += 7;
			break;

		case 0xDB: // OR A,XX,P3 	DB XX 	7 	  	P3 relative	A:=(A)|((P3)+XX)
			R_PC += 1;
			R_EA |= mr8(R_P3+mri8(R_PC));
			Cycles += 7;
			break;

		case 0xDC: // OR A,=XX 	DC XX 	7 	  	immediate 	A:=(A)|XX
			R_PC += 1;
			R_EA |= mr8(R_PC);
			Cycles += 7;
			break;

		case 0xDD: // OR A,XX 	DD XX 	7 	  	direct 	A:=(A)|(FF00+XX)
			R_PC += 1;
			R_EA |= mr8(0xFF00 | mr8(R_PC));
			Cycles += 7;
			break;

		case 0xDE: // OR A,@XX,P2 	DE XX 	8 	  	auto-indexed 	P2:=(P2)+XX, A:=(A)|((P2))
		{          //                                               A:=(A)|((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			R_EA |= mr8(R_P2);
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0xDF: // OR A,@XX,P3 	DF XX 	8 	  	auto-indexed 	P3:=(P3)+XX, A:=(A)|((P3))
		{          //                                               A:=(A)|((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			R_EA |= mr8(R_P3);
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0x60: // XOR A,E 	60 	4 	  	implicit 	A:=(A)^(E)
			R_EA ^= (R_EA>>8);
			Cycles += 4;
			break;

		case 0xE0: // XOR A,XX,PC 	E0 XX 	7 	  	PC relative	A:=(A)^((PC)+XX)
			R_PC += 1;
			R_EA ^= mr8(R_PC+mri8(R_PC));
			Cycles += 7;
			break;

		case 0xE1: // XOR A,XX,SP 	E1 XX 	7 	  	SP relative	A:=(A)^((SP)+XX)
			R_PC += 1;
			R_EA ^= mr8(R_SP+mri8(R_PC));
			Cycles += 7;
			break;

		case 0xE2: // XOR A,XX,P2 	E2 XX 	7 	  	P2 relative	A:=(A)^((P2)+XX)
			R_PC += 1;
			R_EA ^= mr8(R_P2+mri8(R_PC));
			Cycles += 7;
			break;

		case 0xE3: // XOR A,XX,P3 	E3 XX 	7 	  	P3 relative	A:=(A)^((P3)+XX)
			R_PC += 1;
			R_EA ^= mr8(R_P3+mri8(R_PC));
			Cycles += 7;
			break;

		case 0xE4: // XOR A,=XX 	E4 XX 	7 	  	immediate 	A:=(A)^XX
			R_PC += 1;
			R_EA ^= mr8(R_PC);
			Cycles += 7;
			break;

		case 0xE5: // XOR A,XX 	E5 XX 	7 	  	direct 	A:=(A)^(FF00+XX)
			R_PC += 1;
			R_EA ^= mr8(0xFF00 | mr8(R_PC));
			Cycles += 7;
			break;

		case 0xE6: // XOR A,@XX,P2 	E6 XX 	8 	  	auto-indexed 	P2:=(P2)+XX, A:=(A)^((P2))
		{          //                                               A:=(A)^((P2)), P2:=(P2)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P2 += ofs;
			R_EA ^= mr8(R_P2);
			if (ofs > 0) R_P2 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0xE7: // XOR A,@XX,P3 	E7 XX 	8 	  	auto-indexed 	P3:=(P3)+XX, A:=(A)^((P3))
		{          //                                               A:=(A)^((P3)), P3:=(P3)+XX
			var ofs = mri8(R_PC+1);
			if (ofs < 0) R_P3 += ofs;
			R_EA ^= mr8(R_P3);
			if (ofs > 0) R_P3 += ofs;
			R_PC += 1;
			Cycles += 8;
			break;
		}

		case 0x2D: // BND XX 	2D XX 	? 	  	PC relative	siehe: BND
			opBRANCH(isNotDigit(), R_PC+1);
			break;

		case 0x7C: // BNZ XX 	7C XX 	5 	  	PC relative	wenn (A)<>0 dann PC:=(PC)+XX
			opBRANCH((R_EA & 0xFF) != 0, R_PC+1);
			break;

		case 0x7E: // BNZ XX,P2 	7E XX 	5 	  	P2 relative	wenn (A)<>0 dann PC:=(P2)+XX
			opBRANCH((R_EA & 0xFF) != 0, R_P2);
			break;

		case 0x7F: // BNZ XX,P3 	7F XX 	5 	  	P3 relative	wenn (A)<>0 dann PC:=(P3)+XX
			opBRANCH((R_EA & 0xFF) != 0, R_P3);
			break;

		case 0x64: // BP XX 	64 XX 	5 	  	PC relative	wenn (A)>0 dann PC:=(PC)+XX
			opBRANCH((R_EA & 0x80) == 0, R_PC+1);
			break;

		case 0x66: // BP XX,P2 	66 XX 	5 	  	P2 relative	wenn (A)>0 dann PC:=(P2)+XX
			opBRANCH((R_EA & 0x80) == 0, R_P2);
			break;

		case 0x67: // BP XX,P3 	67 XX 	5 	  	P3 relative	wenn (A)>0 dann PC:=(P3)+XX
			opBRANCH((R_EA & 0x80) == 0, R_P3);
			break;

		case 0x74: // BRA XX 	74 XX 	5 	  	PC relative	PC:=(PC)+XX
			opBRANCH(1, R_PC+1);
			break;

		case 0x76: // BRA XX,P2 	76 XX 	5 	  	P2 relative	PC:=(P2)+XX
			opBRANCH(1, R_P2);
			break;

		case 0x77: // BRA XX,P3 	77 XX 	5 	  	P3 relative	PC:=(P3)+XX
			opBRANCH(1, R_P3);
			break;

		case 0x6C: // BZ XX 	6C XX 	5 	  	PC relative	wenn (A)=0 dann PC:=(PC)+XX
			opBRANCH((R_EA & 0xFF) == 0, R_PC+1);
			break;

		case 0x6E: // BZ XX,P2 	6E XX 	5 	  	P2 relative	wenn (A)=0 dann PC:=(P2)+XX
			opBRANCH((R_EA & 0xFF) == 0, R_P2);
			break;

		case 0x6F: // BZ XX,P3 	6F XX 	5 	  	P3 relative	wenn (A)=0 dann PC:=(P3)+XX
			opBRANCH((R_EA & 0xFF) == 0, R_P3);
			break;

		case 0x10: // CALL 0 	10 	17 	  	indirect 	(--(SP)):=(PC), PC:=(20h)
			opCALL(0x20);
			break;

		case 0x11: // CALL 1 	11 	17 	  	indirect 	(--(SP)):=(PC), PC:=(22h)
			opCALL(0x22);
			break;

		case 0x12: // CALL 2 	12 	17 	  	indirect 	(--(SP)):=(PC), PC:=(24h)
			opCALL(0x24);
			break;

		case 0x13: // CALL 3 	13 	17 	  	indirect 	(--(SP)):=(PC), PC:=(26h)
			opCALL(0x26);
			break;

		case 0x14: // CALL 4 	14 	17 	  	indirect 	(--(SP)):=(PC), PC:=(28h)
			opCALL(0x28);
			break;

		case 0x15: // CALL 5 	15 	17 	  	indirect 	(--(SP)):=(PC), PC:=(2Ah)
			opCALL(0x2A);
			break;

		case 0x16: // CALL 6 	16 	17 	  	indirect 	(--(SP)):=(PC), PC:=(2Ch)
			opCALL(0x2C);
			break;

		case 0x17: // CALL 7 	17 	17 	  	indirect 	(--(SP)):=(PC), PC:=(2Eh)
			opCALL(0x2E);
			break;

		case 0x18: // CALL 8 	18 	17 	  	indirect 	(--(SP)):=(PC), PC:=(30h)
			opCALL(0x30);
			break;

		case 0x19: // CALL 9 	19 	17 	  	indirect 	(--(SP)):=(PC), PC:=(32h)
			opCALL(0x32);
			break;

		case 0x1A: // CALL A 	1A 	17 	  	indirect 	(--(SP)):=(PC), PC:=(34h)
			opCALL(0x34);
			break;

		case 0x1B: // CALL B 	1B 	17 	  	indirect 	(--(SP)):=(PC), PC:=(36h)
			opCALL(0x36);
			break;

		case 0x1C: // CALL C 	1C 	17 	  	indirect 	(--(SP)):=(PC), PC:=(38h)
			opCALL(0x38);
			break;

		case 0x1D: // CALL D 	1D 	17 	  	indirect 	(--(SP)):=(PC), PC:=(3Ah)
			opCALL(0x3A);
			break;

		case 0x1E: // CALL E 	1E 	17 	  	indirect 	(--(SP)):=(PC), PC:=(3Ch)
			opCALL(0x3C);
			break;

		case 0x1F: // CALL F 	1F 	17 	  	indirect 	(--(SP)):=(PC), PC:=(3Eh)
			opCALL(0x3E);
			break;

		case 0x24: // JMP XXYY 	24 YY XX 	8 	  	absolut 	PC:=XXYY
			R_PC = mr16(R_PC+1);
			Cycles += 8;
			break;
			
		case 0x20: // JSR XXYY 	20 YY XX 	15 	  	absolut 	(--(SP)):=(PC), PC:=XXYY
			R_SP = w16(R_SP-2);
			mw16(R_SP, R_PC+2);
			R_PC = mr16(R_PC+1);
			Cycles += 15;
			break;

		case 0x5C: // RET 	5C 	10 	  	implicit 	PC:=((SP)++)
			R_PC = mr16(R_SP);
			R_SP = w16(R_SP+2);
			Cycles += 10;
			break;

		case 0x2E: // SSM P2 	2E 	? 	  	indiziert 	siehe: SSM
			R_P2 = opSSM(R_P2);
			break;

		case 0x2F: // SSM P3 	2F 	? 	  	indiziert 	siehe: SSM
			R_P3 = opSSM(R_P3);
			break;
			
		case 0x00: // NOP 	00 	3 	  	implicit 	(PC)++
			Cycles += 3;
			break;

		case 0x08: // PUSH EA 	08 	8 	  	implicit 	(--(SP)):=(EA)
			opPUSH16(R_EA);
			break;

		case 0x0A: // PUSH A 	0A 	5 	  	implicit 	(--(SP)):=(A)
			R_SP = w16(R_SP-1);
			mw8(R_SP, R_EA);
			Cycles += 5;
			break;

		case 0x54: // PUSH PC 	54 	8 	  	implicit 	(--(SP)):=(PC)
			opPUSH16(R_PC);
			break;

		case 0x56: // PUSH P2 	56 	8 	  	implicit 	(--(SP)):=(P2)
			opPUSH16(R_P2);
			break;

		case 0x57: // PUSH P3 	57 	8 	  	implicit 	(--(SP)):=(P3)
			opPUSH16(R_P3);
			break;

		case 0x38: // POP A 	38 	6 	  	implicit 	A:=((SP)++)
			set_A(mr8(R_SP));
			R_SP += 1;
			break;

		case 0x3A: // POP EA 	3A 	9 	  	implicit 	AE:=((SP)++)
			R_EA = opPOP16();
			break;

		case 0x5E: // POP P2 	5E 	10 	  	implicit 	P2:=((SP)++)
			R_P2 = opPOP16();
			break;

		case 0x5F: // POP P3 	5F 	10 	  	implicit 	P3:=((SP)++)
			R_P3 = opPOP16();
			break;

		case 0x22: // PLI P2,=XXYY 	22 YY XX 	15 	  	immediate 	(--(SP)):=(P2), P2:=XXYY
			R_SP = w16(R_SP-2);
			mw16(R_SP, R_P2);
			R_P2 = mr16(PC+1);
			PC += 2;
			Cycles += 15;
			break;

		case 0x23: // PLI P3,=XXYY 	23 YY XX 	15 	  	immediate 	(--(SP)):=(P3), P3:=XXYY
			R_SP = w16(R_SP-2);
			mw16(R_SP, R_P2);
			R_P3 = mr16(PC+1);
			PC += 2;
			Cycles += 15;
			break;

		case 0x3C: // SR A 	3C 	3 	  	implicit 	0 nach rechts in A schieben
			set_A((R_EA&0xFF)>>1);
			Cycles += 3;
			break;

		case 0x3D: // SRL A 	3D 	3 	  	implicit 	L nach rechts in A schieben
			set_A(((R_EA&0xFF)>>1) | (isCYL() << 7));
			Cycles += 3;
			break;

		case 0x0C: // SR EA 	0C 	4 	  	implicit 	0 nach rechts in EA schieben
			R_EA = R_EA >> 1;
			Cycles += 4;
			break;

		case 0x0E: // SL A 	0E 	3 	  	implicit 	0 nach links in A schieben
			set_A((R_EA & 0xFF) << 1);
			Cycles += 3;
			break;

		case 0x0F: // SL EA 	0F 	4 	  	implicit 	0 nach links in EA schieben
			R_EA = R_EA << 1;
			Cycles += 4;
			break;

		case 0x3E: // RR A 	3E 	3 	  	implicit 	A nach rechts rotieren
			set_A(((R_EA & 0xFF) >> 1) | ((R_EA & 1)<<7));
			Cycles += 3;
			break;

		case 0x3F: // RRL A 	3F 	3 	* 	implicit 	A nach rechts durch L rotieren
			var L = R_EA & 1;
			set_A(((R_EA & 0xFF) >> 1) | ((isCYL() & 1)<<7));
			set_CYL(L);
			Cycles += 3;
			break;

		default:
			console.log("unsupported OPCODE:", hex(Memory[R_PC]));
			/*
			R_PC -= 1;
			cpu_halt();
			*/
			break;
	}

	// each instruction increments PC, even after a JMP/JSR/RTS/...
	R_PC += 1;
	R_PC &= 0xffff;

	cpu_show();
	if (R_PC == BreakPoint_PC)
		cpu_halt();

	/* clear input sensors in status flag: this is "latched" to allow single stepping.
	 * Pressing the button (briefly) enables S_A/S_B for the next step.
	 * Releasing the button only clears the flag after one CPU step,
	 * unless it was pressed again. */
	if (SensorsCleared != 0)
	{
		if ((SensorsSet & SensorsCleared) == 0)
		{
			R_S &= (0xff ^ SensorsCleared);
			SensorsCleared = 0;
		}
	}
}

memory_init(true);
