  // SPDX-License-Identifier: MIT                                                                                                                                                 
  pragma solidity ^0.8.20;                                                                                                                                                        
                                                                                                                                                                                  
  interface IERC20 {                                                                                                                                                              
      function transferFrom(address from, address to, uint256 amount) external returns (bool);                                                                                    
      function transfer(address to, uint256 amount) external returns (bool);                                                                                                      
      function balanceOf(address account) external view returns (uint256);                                                                                                        
      function allowance(address owner, address spender) external view returns (uint256);                                                                                         
  }                                                                                                                                                                               
                                                                                                                                                                                  
  contract PaymentReceiver {                                                                                                                                                      
      address public owner;                                                                                                                                                       
      IERC20 public immutable usdc;                                                                                                                                               
                                                                                                                                                                                  
      event PaymentReceived(address indexed from, uint256 amount);                                                                                                                
      event Withdrawn(address indexed to, uint256 amount);                                                                                                                        
                                                                                                                                                                                  
      modifier onlyOwner() {                                                                                                                                                      
          require(msg.sender == owner, "Not owner");                                                                                                                              
          _;                                                                                                                                                                      
      }                                                                                                                                                                           
                                                                                                                                                                                  
      constructor(address _usdc) {                                                                                                                                                
          owner = msg.sender;                                                                                                                                                     
          usdc = IERC20(_usdc);                                                                                                                                                   
      }                                                                                                                                                                           
                                                                                                                                                                                  
      function pullPayment(address from, uint256 amount) external onlyOwner returns (bool) {                                                                                      
          require(usdc.transferFrom(from, address(this), amount), "Transfer failed");                                                                                             
          emit PaymentReceived(from, amount);                                                                                                                                     
          return true;                                                                                                                                                            
      }                                                                                                                                                                           
                                                                                                                                                                                  
      function withdraw(address to, uint256 amount) external onlyOwner {                                                                                                          
          uint256 bal = usdc.balanceOf(address(this));                                                                                                                            
          uint256 amt = amount == 0 ? bal : amount;                                                                                                                               
          require(usdc.transfer(to, amt), "Transfer failed");                                                                                                                     
          emit Withdrawn(to, amt);                                                                                                                                                
      }                                                                                                                                                                           
                                                                                                                                                                                  
      function balance() external view returns (uint256) {                                                                                                                        
          return usdc.balanceOf(address(this));                                                                                                                                   
      }                                                                                                                                                                           
                                                                                                                                                                                  
      function getAllowance(address user) external view returns (uint256) {                                                                                                       
          return usdc.allowance(user, address(this));                                                                                                                             
      }                                                                                                                                                                           
  }                                 