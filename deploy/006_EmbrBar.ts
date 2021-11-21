import { bn } from "../test/utilities"
import { HardhatRuntimeEnvironment } from "hardhat/types"

export default async function ({ ethers, deployments, getNamedAccounts, network }: HardhatRuntimeEnvironment) {
  const { deploy } = deployments
  const { deployer, dev, treasury } = await getNamedAccounts()

  const { address, args } = await deploy("EmbrBar", {
    from: deployer,
    args: [process.env.FEMBR_VESTED_TOKEN],
    log: true,
    deterministicDeployment: false,
    contract: "contracts/EmbrBar.sol:EmbrBar",
  })
}
